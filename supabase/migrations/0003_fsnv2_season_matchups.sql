-- =============================================================================
-- FSN v2 — Season Matchup Engine & Scoreboard (Phase 2)
-- Applied to the Supabase project `FSN` as migration `fsnv2_season_matchups`.
--
-- Phase 1 ended when the 180th pick landed. This migration turns those rosters
-- into a 14-week season: a round-robin schedule, weekly player scores, and the
-- W-L / Points For / Points Against table that the League Overview reads.
--
-- The schedule generator is deterministic. `fsnv2_lcg_shuffle` and
-- `fsnv2_round_robin` are mirrored verbatim in js/seasonEngine.js, so the
-- browser can build the identical 14 weeks offline and the two never disagree
-- about who plays whom.
-- =============================================================================

-- ---------------------------------------------------------------- matchups --
-- One row per head-to-head game. 12 teams => 6 rows per week => 84 rows.
create table if not exists fsnv2.matchups (
  id           uuid primary key default gen_random_uuid(),
  league_id    uuid not null references fsnv2.leagues(id) on delete cascade,
  week         integer not null check (week between 1 and 18),
  team_a_id    integer not null check (team_a_id >= 1),
  team_b_id    integer not null check (team_b_id >= 1),
  team_a_score numeric(7,2) not null default 0,
  team_b_score numeric(7,2) not null default 0,
  status       text not null default 'scheduled'
                 check (status in ('scheduled','in_progress','final')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint matchups_distinct_teams check (team_a_id <> team_b_id),
  constraint matchups_unique_home unique (league_id, week, team_a_id),
  constraint matchups_unique_away unique (league_id, week, team_b_id)
);
create index if not exists matchups_league_week_idx on fsnv2.matchups (league_id, week);

-- The pair of unique constraints stops a team hosting twice or travelling
-- twice in one week, but not hosting one game and travelling to another.
-- `fsnv2_generate_schedule` is the only writer and asserts the perfect
-- matching before it commits, so that case cannot be reached from the app.

-- ------------------------------------------------------ player week scores --
-- The per-player box score behind each matchup total. No FK to fsnv2.players:
-- the projection pool syncs asynchronously on boot, and a slow sync must never
-- be able to reject a simulated week.
create table if not exists fsnv2.player_week_scores (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references fsnv2.leagues(id) on delete cascade,
  week       integer not null check (week between 1 and 18),
  team_id    integer not null check (team_id >= 1),
  player_id  text not null,
  slot       text not null,
  starter    boolean not null default false,
  projected  numeric(6,2) not null default 0,
  points     numeric(6,2) not null default 0,
  created_at timestamptz not null default now(),
  constraint player_week_scores_unique unique (league_id, week, player_id)
);
create index if not exists player_week_scores_team_idx
  on fsnv2.player_week_scores (league_id, week, team_id);

drop trigger if exists matchups_touch on fsnv2.matchups;
create trigger matchups_touch before update on fsnv2.matchups
  for each row execute function fsnv2.touch_updated_at();

alter table fsnv2.matchups           enable row level security;
alter table fsnv2.player_week_scores enable row level security;

-- =============================================================================
-- Deterministic schedule math — mirrored in js/seasonEngine.js
-- =============================================================================

-- Park–Miller minstd shuffle of [0 .. p_count-1].
--
-- The multiplier is small enough that `state * 16807` stays inside IEEE-754's
-- exact integer range, so JavaScript's Number arithmetic and Postgres bigint
-- arithmetic produce the identical stream for a given seed. That is what lets
-- the browser rebuild weeks 12-14 offline and still match these rows.
create or replace function public.fsnv2_lcg_shuffle(
  p_count integer,
  p_seed  integer
) returns integer[]
language plpgsql immutable as $$
declare
  v_state bigint;
  v_order integer[];
  i integer;
  j integer;
  v_tmp integer;
begin
  if p_count <= 0 then return array[]::integer[]; end if;

  -- Cast first: `p_seed % 2147483647 + 2147483647` overflows int4 for any
  -- positive seed, so the whole normalisation runs in bigint.
  v_state := ((p_seed::bigint % 2147483647) + 2147483647) % 2147483647;
  if v_state = 0 then v_state := 1; end if;

  v_order := array(select generate_series(0, p_count - 1));

  -- Fisher–Yates, walking down so each draw picks from the unshuffled head.
  for i in reverse p_count - 1 .. 1 loop
    v_state := (v_state * 16807) % 2147483647;
    j := floor((v_state::double precision / 2147483647.0) * (i + 1))::integer;
    v_tmp            := v_order[i + 1];
    v_order[i + 1]   := v_order[j + 1];
    v_order[j + 1]   := v_tmp;
  end loop;

  return v_order;
end;
$$;

-- Circle-method round robin over teams 1..N.
--
-- Team 1 stays fixed and the other N-1 rotate one position per round, which
-- yields N-1 rounds in which every team meets every other team exactly once.
-- Returns [[[a,b], ...6 pairs...], ...11 rounds...] for a 12-team league.
create or replace function public.fsnv2_round_robin(p_total_teams integer)
returns jsonb
language plpgsql immutable as $$
declare
  v_fixed  integer := 1;
  v_rot    integer[];
  v_len    integer;
  v_rounds jsonb := '[]'::jsonb;
  v_pairs  jsonb;
  r integer;
  i integer;
begin
  if p_total_teams < 2 or p_total_teams % 2 <> 0 then
    raise exception 'round robin needs an even team count, got %', p_total_teams
      using errcode = 'P0001';
  end if;

  v_rot := array(select generate_series(2, p_total_teams));
  v_len := array_length(v_rot, 1);

  for r in 1 .. p_total_teams - 1 loop
    v_pairs := jsonb_build_array(jsonb_build_array(v_fixed, v_rot[1]));
    for i in 1 .. (p_total_teams / 2) - 1 loop
      v_pairs := v_pairs || jsonb_build_array(
        jsonb_build_array(v_rot[i + 1], v_rot[v_len - i + 1])
      );
    end loop;
    v_rounds := v_rounds || jsonb_build_array(v_pairs);

    -- rotate right by one
    v_rot := array[v_rot[v_len]] || v_rot[1 : v_len - 1];
  end loop;

  return v_rounds;
end;
$$;

-- Builds the full 14-week schedule for a league.
--
--   Weeks 1-11  the complete round robin, in order: every team plays every
--               other team exactly once.
--   Weeks 12-14 a randomised rotation — three of those same eleven rounds,
--               drawn by the seeded shuffle, with home and away flipped so the
--               rematch is played at the other franchise.
--
-- Idempotent: returns the existing schedule untouched unless p_replace is true.
create or replace function public.fsnv2_generate_schedule(
  p_league_id uuid,
  p_weeks     integer default 14,
  p_seed      integer default 20260208,
  p_replace   boolean default false
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_total      integer;
  v_existing   integer;
  v_rounds     jsonb;
  v_round_count integer;
  v_regular    integer;
  v_extra      integer;
  v_order      integer[];
  v_pairs      jsonb;
  v_pair       jsonb;
  v_week       integer;
  v_round_idx  integer;
  v_flip       boolean;
  v_bad        integer;
begin
  select l.total_teams into v_total from fsnv2.leagues l where l.id = p_league_id;
  if not found then
    raise exception 'league % not found', p_league_id using errcode = 'P0002';
  end if;
  if p_weeks < 1 or p_weeks > 18 then
    raise exception 'week count must be between 1 and 18, got %', p_weeks
      using errcode = 'P0001';
  end if;

  select count(*) into v_existing from fsnv2.matchups where league_id = p_league_id;
  if v_existing > 0 and not p_replace then
    return public.fsnv2_matchups(p_league_id);
  end if;

  delete from fsnv2.matchups           where league_id = p_league_id;
  delete from fsnv2.player_week_scores where league_id = p_league_id;

  v_rounds      := public.fsnv2_round_robin(v_total);
  v_round_count := jsonb_array_length(v_rounds);          -- 11 for 12 teams
  v_regular     := least(p_weeks, v_round_count);
  v_extra       := p_weeks - v_regular;
  v_order       := public.fsnv2_lcg_shuffle(v_round_count, p_seed);

  for v_week in 1 .. p_weeks loop
    if v_week <= v_regular then
      v_round_idx := v_week - 1;                          -- 0-based, in order
      v_flip      := false;
    else
      -- Randomised rotation for the closing weeks; wraps if a league ever asks
      -- for more extra weeks than there are rounds to draw from.
      v_round_idx := v_order[((v_week - v_regular - 1) % v_round_count) + 1];
      v_flip      := true;
    end if;

    v_pairs := v_rounds -> v_round_idx;

    for v_pair in select * from jsonb_array_elements(v_pairs) loop
      insert into fsnv2.matchups (league_id, week, team_a_id, team_b_id)
      values (
        p_league_id,
        v_week,
        ((case when v_flip then v_pair -> 1 else v_pair -> 0 end) #>> '{}')::integer,
        ((case when v_flip then v_pair -> 0 else v_pair -> 1 end) #>> '{}')::integer
      );
    end loop;
  end loop;

  -- Assert the perfect matching: every team exactly once per week.
  select count(*) into v_bad from (
    select week, team_id, count(*) as n
      from (
        select week, team_a_id as team_id from fsnv2.matchups where league_id = p_league_id
        union all
        select week, team_b_id             from fsnv2.matchups where league_id = p_league_id
      ) s
     group by week, team_id
    having count(*) <> 1
  ) bad;
  if v_bad > 0 then
    raise exception 'generated schedule is not a perfect matching (% offending team-weeks)', v_bad
      using errcode = 'P0001';
  end if;

  return public.fsnv2_matchups(p_league_id);
end;
$$;

-- Reads the schedule, optionally for a single week.
create or replace function public.fsnv2_matchups(
  p_league_id uuid,
  p_week      integer default null
) returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(to_jsonb(m) order by m.week, m.team_a_id), '[]'::jsonb)
  from fsnv2.matchups m
  where m.league_id = p_league_id
    and (p_week is null or m.week = p_week);
$$;

-- Persists one simulated week.
--
-- p_scores is the box score the client computed:
--   [{"team_id":1,"player_id":"p-0007","slot":"QB","starter":true,
--     "projected":22.6,"points":25.1}, ...]
--
-- Team totals are summed here from the rows just written rather than trusted
-- from the client, so a matchup row can never disagree with the box score
-- underneath it.
create or replace function public.fsnv2_simulate_week(
  p_league_id uuid,
  p_week      integer,
  p_scores    jsonb
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare v_games integer;
begin
  select count(*) into v_games
    from fsnv2.matchups where league_id = p_league_id and week = p_week;
  if v_games = 0 then
    raise exception 'no schedule for league % week % — generate it first', p_league_id, p_week
      using errcode = 'P0002';
  end if;

  delete from fsnv2.player_week_scores where league_id = p_league_id and week = p_week;

  insert into fsnv2.player_week_scores
    (league_id, week, team_id, player_id, slot, starter, projected, points)
  select
    p_league_id,
    p_week,
    (s ->> 'team_id')::integer,
    (s ->> 'player_id')::text,
    coalesce(s ->> 'slot', 'BN'),
    coalesce((s ->> 'starter')::boolean, false),
    coalesce((s ->> 'projected')::numeric, 0),
    coalesce((s ->> 'points')::numeric, 0)
  from jsonb_array_elements(coalesce(p_scores, '[]'::jsonb)) as s;

  update fsnv2.matchups m
     set team_a_score = (
           select coalesce(sum(w.points), 0)
             from fsnv2.player_week_scores w
            where w.league_id = m.league_id and w.week = m.week
              and w.team_id = m.team_a_id and w.starter
         ),
         team_b_score = (
           select coalesce(sum(w.points), 0)
             from fsnv2.player_week_scores w
            where w.league_id = m.league_id and w.week = m.week
              and w.team_id = m.team_b_id and w.starter
         ),
         status = 'final'
   where m.league_id = p_league_id and m.week = p_week;

  return jsonb_build_object(
    'week',      p_week,
    'matchups',  public.fsnv2_matchups(p_league_id, p_week),
    'standings', public.fsnv2_season_standings(p_league_id)
  );
end;
$$;

-- Rolls a week (or the whole season, when p_week is null) back to unplayed.
create or replace function public.fsnv2_reset_season(
  p_league_id uuid,
  p_week      integer default null
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
begin
  delete from fsnv2.player_week_scores
   where league_id = p_league_id and (p_week is null or week = p_week);

  update fsnv2.matchups
     set team_a_score = 0, team_b_score = 0, status = 'scheduled'
   where league_id = p_league_id and (p_week is null or week = p_week);

  return jsonb_build_object(
    'matchups',  public.fsnv2_matchups(p_league_id),
    'standings', public.fsnv2_season_standings(p_league_id)
  );
end;
$$;

-- W-L-T, Points For and Points Against — the League Overview table.
-- Only games marked 'final' count, so an unplayed week never moves a record.
create or replace function public.fsnv2_season_standings(p_league_id uuid)
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  with sides as (
    select team_a_id as team_id, team_a_score as pf, team_b_score as pa, status
      from fsnv2.matchups where league_id = p_league_id
    union all
    select team_b_id, team_b_score, team_a_score, status
      from fsnv2.matchups where league_id = p_league_id
  ), totals as (
    select
      team_id,
      count(*) filter (where status = 'final')                       as games,
      count(*) filter (where status = 'final' and pf > pa)           as wins,
      count(*) filter (where status = 'final' and pf < pa)           as losses,
      count(*) filter (where status = 'final' and pf = pa)           as ties,
      coalesce(sum(pf) filter (where status = 'final'), 0)           as points_for,
      coalesce(sum(pa) filter (where status = 'final'), 0)           as points_against
    from sides
    group by team_id
  )
  select coalesce(jsonb_agg(to_jsonb(t) order by t.wins desc, t.points_for desc, t.team_id), '[]'::jsonb)
  from totals t;
$$;

-- Everything the Matchup / Scoreboard hub needs in one round trip.
create or replace function public.fsnv2_season_state(p_league_id uuid)
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select jsonb_build_object(
    'league_id', p_league_id,
    'matchups',  public.fsnv2_matchups(p_league_id),
    'standings', public.fsnv2_season_standings(p_league_id),
    'scores',    coalesce((
      select jsonb_agg(to_jsonb(w) order by w.week, w.team_id)
      from fsnv2.player_week_scores w where w.league_id = p_league_id
    ), '[]'::jsonb)
  );
$$;

grant execute on function
  public.fsnv2_lcg_shuffle(integer, integer),
  public.fsnv2_round_robin(integer),
  public.fsnv2_generate_schedule(uuid, integer, integer, boolean),
  public.fsnv2_matchups(uuid, integer),
  public.fsnv2_simulate_week(uuid, integer, jsonb),
  public.fsnv2_reset_season(uuid, integer),
  public.fsnv2_season_standings(uuid),
  public.fsnv2_season_state(uuid)
to anon, authenticated;
