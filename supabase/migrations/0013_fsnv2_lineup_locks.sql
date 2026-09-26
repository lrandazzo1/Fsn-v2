-- =============================================================================
-- FSN v2 — Lineup locks
--
-- Migration 0008 made a lineup swap persistent. It did not make it *timely*: a
-- manager could watch the Packers score on Thursday night and only then decide
-- to start (or bench) them, because nothing compared the swap against the NFL
-- clock. This migration closes that, in the one place a swap is actually
-- written.
--
--   public.fsnv2_current_nfl_week   the week a timestamp falls in
--   public.fsnv2_player_locked      has this team's game started?
--   public.fsnv2_locked_players     the locked ones out of a set of players
--   public.fsnv2_swap_lineup        0008's function, plus the guard
--
-- The predicate is a deliberate mirror of `isPlayerLocked()` in js/gameLock.js:
--
--   locked  =  status in ('in_progress','final')
--              or (status not in ('postponed','canceled') and now >= kickoff)
--   a team with no game that week (a BYE, or an unsynced week) is never locked
--
-- Both sides have to agree, because both are reachable. The browser and
-- api/roster/swap.js check the JavaScript one for an instant, explainable
-- refusal; this one is what stops a stale tab, a replayed request or a
-- hand-rolled PostgREST call from writing a lineup the UI would never have
-- allowed — and it runs inside the same transaction as the write, so a kickoff
-- that lands mid-request cannot slip through. If you change one, change the
-- other.
--
-- Kickoffs come from fsnv2.nfl_matchups, which the sync service fills from the
-- provider's schedule payload (gameTime_epoch / gameStatus / gameTime).
-- =============================================================================

-- ----------------------------------------------------------- the calendar --
-- Mirrors js/nflWeek.js: week 1 opens the Thursday after Labor Day — the first
-- Monday of September — and weeks run Thursday to Wednesday, clamped to 1..18.
create or replace function public.fsnv2_current_nfl_week(
  p_now    timestamptz default now(),
  p_season integer default null
) returns integer
language sql immutable as $$
  with season as (
    select coalesce(
      p_season,
      case when extract(month from p_now at time zone 'UTC') >= 3
        then extract(year from p_now at time zone 'UTC')::integer
        else extract(year from p_now at time zone 'UTC')::integer - 1 end
    ) as year
  ), kickoff as (
    -- The first Monday of September, plus three days, at midnight UTC — the
    -- same instant Date.UTC(season, 8, firstMonday + 3) produces in JavaScript.
    select ((make_date(year, 9, 1)
             + ((8 - extract(dow from make_date(year, 9, 1))::integer) % 7)
             + 3)::timestamp at time zone 'UTC') as opens
    from season
  )
  select greatest(1, least(18,
    floor(extract(epoch from (p_now - opens)) / 604800)::integer + 1))
  from kickoff;
$$;

comment on function public.fsnv2_current_nfl_week(timestamptz, integer) is
  'The NFL regular-season week a timestamp falls in. Mirrors getCurrentNFLWeek() in js/nflWeek.js.';

/* The season a timestamp belongs to — Sep-Feb belongs to the earlier year. */
create or replace function public.fsnv2_current_nfl_season(
  p_now timestamptz default now()
) returns integer
language sql immutable as $$
  select case when extract(month from p_now at time zone 'UTC') >= 3
    then extract(year from p_now at time zone 'UTC')::integer
    else extract(year from p_now at time zone 'UTC')::integer - 1 end;
$$;

-- ------------------------------------------------------- the lock predicate --
-- select public.fsnv2_player_locked('GB', 2026, 3);
create or replace function public.fsnv2_player_locked(
  p_team        text,
  p_season      integer,
  p_week        integer,
  p_now         timestamptz default now(),
  p_season_type text default 'reg'
) returns boolean
language sql stable security definer set search_path = fsnv2, public as $$
  select coalesce(
    bool_or(
      case
        -- A game that was called off never starts, whatever the clock says.
        when m.status in ('postponed', 'canceled') then false
        when m.status in ('in_progress', 'final')  then true
        when m.kickoff is not null                 then coalesce(p_now, now()) >= m.kickoff
        else false
      end
    ),
    false
  )
  from fsnv2.nfl_matchups m
  where m.season = p_season
    and m.week = p_week
    and m.season_type = coalesce(p_season_type, 'reg')
    and upper(coalesce(p_team, '')) in (upper(m.home_team), upper(m.away_team));
$$;

-- --------------------------------------------------------- the lock report --
-- Which of these players are frozen, and why — what api/roster/swap.js turns
-- into its 400. The season and week default to the ones `p_now` falls in, so a
-- caller that only knows the two player ids still gets a correct answer.
create or replace function public.fsnv2_locked_players(
  p_player_ids  text[],
  p_now         timestamptz default now(),
  p_season      integer default null,
  p_week        integer default null,
  p_season_type text default 'reg'
) returns jsonb
language sql stable security definer set search_path = fsnv2, public as $$
  with ask as (
    select coalesce(p_now, now()) as at,
           coalesce(p_season, public.fsnv2_current_nfl_season(coalesce(p_now, now()))) as season,
           coalesce(p_week, public.fsnv2_current_nfl_week(coalesce(p_now, now()), p_season)) as week
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'player_id', p.id,
        'name',      p.name,
        'team',      p.team,
        'week',      ask.week,
        'kickoff',   (select min(m.kickoff) from fsnv2.nfl_matchups m
                       where m.season = ask.season and m.week = ask.week
                         and m.season_type = coalesce(p_season_type, 'reg')
                         and upper(p.team) in (upper(m.home_team), upper(m.away_team))),
        'status',    (select min(m.status) from fsnv2.nfl_matchups m
                       where m.season = ask.season and m.week = ask.week
                         and m.season_type = coalesce(p_season_type, 'reg')
                         and upper(p.team) in (upper(m.home_team), upper(m.away_team)))
      )
      order by p.name
    ),
    '[]'::jsonb
  )
  from ask, fsnv2.players p
  where p.id = any(coalesce(p_player_ids, '{}'::text[]))
    and public.fsnv2_player_locked(p.team, ask.season, ask.week, ask.at, p_season_type);
$$;

-- ============================================================================
-- The guarded swap.
--
-- Identical to migration 0008's function — same signature, so PostgREST still
-- matches the same request body and api/roster/swap.js needs no new parameter —
-- with one block added: neither player may be in a game that has already
-- started. The rest of the body is 0008's, kept verbatim so the two can be
-- diffed.
-- ============================================================================
create or replace function public.fsnv2_swap_lineup(
  p_draft_id uuid, p_team_id integer, p_from text, p_to text,
  p_from_player text, p_to_player text, p_expected_version integer
) returns jsonb language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_state jsonb;
  v_roster jsonb;
  v_from_position text;
  v_to_position text;
  v_keys text[] := array['QB','RB1','RB2','WR1','WR2','TE','FLEX','DST','K','BN1','BN2','BN3','BN4','BN5','BN6'];
  v_count integer;
  v_now timestamptz := now();
  v_season integer := public.fsnv2_current_nfl_season(now());
  v_week integer := public.fsnv2_current_nfl_week(now());
  v_locked_name text;
begin
  -- Serializes swaps and draft writes on this draft; the version rejects stale tabs.
  perform 1 from fsnv2.drafts where id = p_draft_id for update;
  if not found then raise exception 'draft not found' using errcode = 'P0002'; end if;
  v_state := public.fsnv2_lineup_state(p_draft_id, p_team_id);
  v_roster := v_state -> 'roster';
  if p_from is null or p_to is null or p_from = p_to or
     p_from <> all(v_keys) or p_to <> all(v_keys) or
     (v_state ->> 'version')::integer <> p_expected_version or
     v_roster ->> p_from is distinct from p_from_player or
     v_roster ->> p_to is distinct from p_to_player or p_from_player is null then
    raise exception 'lineup changed; reload before swapping' using errcode = 'P0001';
  end if;
  select position into v_from_position from fsnv2.players where id = p_from_player;
  if p_to_player is not null then
    select position into v_to_position from fsnv2.players where id = p_to_player;
  end if;

  -- The lock. Both sides, before anything is written: the player moving into
  -- the lineup and the one moving out are equally frozen once their game is
  -- under way. Mirrors isPlayerLocked() in js/gameLock.js.
  select p.name into v_locked_name
    from fsnv2.players p
   where p.id in (p_from_player, p_to_player)
     and public.fsnv2_player_locked(p.team, v_season, v_week, v_now)
   order by p.name
   limit 1;
  if v_locked_name is not null then
    raise exception 'Cannot move player: % is locked because their game has already started.', v_locked_name
      using errcode = 'P0001';
  end if;

  if v_from_position is null or
     not (p_to like 'BN%' or p_to = v_from_position or
       (p_to in ('RB1','RB2') and v_from_position = 'RB') or
       (p_to in ('WR1','WR2') and v_from_position = 'WR') or
       (p_to = 'FLEX' and v_from_position in ('RB','WR','TE'))) or
     (p_to_player is not null and not (
       p_from like 'BN%' or p_from = v_to_position or
       (p_from in ('RB1','RB2') and v_to_position = 'RB') or
       (p_from in ('WR1','WR2') and v_to_position = 'WR') or
       (p_from = 'FLEX' and v_to_position in ('RB','WR','TE')))) then
    raise exception 'position is not eligible for this slot' using errcode = 'P0001';
  end if;

  -- Existing mappings must still contain precisely the drafted player set.
  select count(*) into v_count from fsnv2.draft_picks
    where draft_id = p_draft_id and team_id = p_team_id;
  if v_count <> (select count(*) from jsonb_each_text(v_roster) r where r.value is not null) or
     exists (select 1 from fsnv2.draft_picks p where p.draft_id = p_draft_id
       and p.team_id = p_team_id and not exists (
         select 1 from jsonb_each_text(v_roster) r where r.value = p.player_id)) then
    -- The client validates the same invariant on hydration; reject stale maps.
    raise exception 'draft roster changed; reload lineup' using errcode = 'P0001';
  end if;
  v_roster := jsonb_set(jsonb_set(v_roster, array[p_from], coalesce(to_jsonb(p_to_player), 'null'::jsonb)),
    array[p_to], to_jsonb(p_from_player));
  insert into fsnv2.lineups (draft_id, team_id, roster, version)
  values (p_draft_id, p_team_id, v_roster, p_expected_version + 1)
  on conflict (draft_id, team_id) do update
    set roster = excluded.roster, version = excluded.version;
  return jsonb_build_object('roster', v_roster, 'version', p_expected_version + 1);
end;
$$;

-- ------------------------------------------------------------------ grants --
-- Reads are granted the same way the other read RPCs are: the app holds a
-- publishable key, and the tables stay behind RLS.
grant execute on function
  public.fsnv2_current_nfl_week(timestamptz, integer),
  public.fsnv2_current_nfl_season(timestamptz),
  public.fsnv2_player_locked(text, integer, integer, timestamptz, text),
  public.fsnv2_locked_players(text[], timestamptz, integer, integer, text)
to anon, authenticated, service_role;

-- PostgREST answers from a cached copy of the catalog, so a freshly created
-- function is invisible until the cache is refreshed. Ask for the refresh here
-- so applying the migration is enough (see the same note in 0008).
notify pgrst, 'reload schema';
