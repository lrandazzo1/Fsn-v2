-- =============================================================================
-- FSN v2 — public RPC surface for the draft engine.
-- Applied to the Supabase project `FSN` as migration `fsnv2_draft_engine_rpc`.
--
-- The fsnv2.* tables stay locked behind RLS; the browser talks to these
-- security-definer functions, which enforce snake order server-side.
--
-- NOTE (Phase 1): this demo has no auth, so the RPCs are granted to `anon`.
-- Phase 2 should scope them to auth.uid() via a league_members table.
-- =============================================================================

-- Canonical snake math, shared by the app, the RPCs and the test suite.
create or replace function public.fsnv2_snake_team(
  p_pick_number integer,
  p_total_teams integer,
  p_draft_type  text default 'snake'
) returns integer
language sql immutable as $$
  select case
    when p_draft_type = 'linear' then ((p_pick_number - 1) % p_total_teams) + 1
    when ((p_pick_number - 1) / p_total_teams) % 2 = 0
      then ((p_pick_number - 1) % p_total_teams) + 1                      -- odd round: 1 -> N
      else p_total_teams - ((p_pick_number - 1) % p_total_teams)          -- even round: N -> 1
  end;
$$;

create or replace function public.fsnv2_create_league(
  p_name            text,
  p_total_teams     integer default 12,
  p_scoring_type    text default 'ppr',
  p_roster_settings jsonb default null
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare v_league fsnv2.leagues;
begin
  insert into fsnv2.leagues (name, total_teams, scoring_type, roster_settings)
  values (
    p_name, p_total_teams, p_scoring_type,
    coalesce(p_roster_settings,
      jsonb_build_object(
        'starters', jsonb_build_object('QB',1,'RB',2,'WR',2,'TE',1,'FLEX',1,'DST',1,'K',1),
        'bench', 6,
        'flex_positions', jsonb_build_array('RB','WR','TE')))
  )
  returning * into v_league;
  return to_jsonb(v_league);
end;
$$;

create or replace function public.fsnv2_start_draft(
  p_league_id     uuid,
  p_rounds        integer default 15,
  p_timer_seconds integer default 60,
  p_teams         jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare v_draft fsnv2.drafts;
begin
  insert into fsnv2.drafts (league_id, rounds, timer_seconds, teams, status, started_at)
  values (p_league_id, p_rounds, p_timer_seconds, coalesce(p_teams, '[]'::jsonb), 'in_progress', now())
  returning * into v_draft;
  return to_jsonb(v_draft);
end;
$$;

-- Bulk player upsert — syncs the local projection pool into Postgres.
create or replace function public.fsnv2_upsert_players(p_players jsonb)
returns integer
language plpgsql security definer set search_path = fsnv2, public as $$
declare v_count integer;
begin
  with rows as (
    select
      (p ->> 'id')::text       as id,
      (p ->> 'name')::text     as name,
      (p ->> 'position')::text as position,
      (p ->> 'team')::text     as team,
      coalesce((p ->> 'adp')::numeric, 999) as adp,
      coalesce(p -> 'stats', '{}'::jsonb)   as stats
    from jsonb_array_elements(p_players) as p
  ), upserted as (
    insert into fsnv2.players (id, name, position, team, adp, stats)
    select id, name, position, team, adp, stats from rows
    on conflict (id) do update
      set name = excluded.name, position = excluded.position, team = excluded.team,
          adp = excluded.adp, stats = excluded.stats, updated_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$$;

-- Records a pick, enforcing snake order and advancing the clock atomically.
create or replace function public.fsnv2_record_pick(
  p_draft_id    uuid,
  p_pick_number integer,
  p_player_id   text,
  p_team_id     integer default null,
  p_auto        boolean default false,
  p_source      text default 'manual'
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_draft       fsnv2.drafts;
  v_total       integer;
  v_round       integer;
  v_expected    integer;
  v_pick        fsnv2.draft_picks;
  v_total_picks integer;
begin
  select d.* into v_draft from fsnv2.drafts d where d.id = p_draft_id for update;
  if not found then
    raise exception 'draft % not found', p_draft_id using errcode = 'P0002';
  end if;
  if v_draft.status = 'complete' then
    raise exception 'draft % is already complete', p_draft_id using errcode = 'P0001';
  end if;

  select l.total_teams into v_total from fsnv2.leagues l where l.id = v_draft.league_id;
  v_total_picks := v_total * v_draft.rounds;

  if p_pick_number <> v_draft.current_pick then
    raise exception 'out of order pick: got %, draft is on pick %', p_pick_number, v_draft.current_pick
      using errcode = 'P0001';
  end if;
  if p_pick_number > v_total_picks then
    raise exception 'pick % exceeds draft length (%)', p_pick_number, v_total_picks using errcode = 'P0001';
  end if;

  v_round    := ((p_pick_number - 1) / v_total) + 1;
  v_expected := public.fsnv2_snake_team(p_pick_number, v_total, v_draft.draft_type);

  if p_team_id is not null and p_team_id <> v_expected then
    raise exception 'snake order violation: pick % belongs to team %, got %',
      p_pick_number, v_expected, p_team_id using errcode = 'P0001';
  end if;

  insert into fsnv2.draft_picks (draft_id, pick_number, round, team_id, player_id, auto, source)
  values (p_draft_id, p_pick_number, v_round, v_expected, p_player_id, p_auto, p_source)
  returning * into v_pick;

  update fsnv2.drafts
     set current_pick = least(p_pick_number + 1, v_total_picks),
         status       = case when p_pick_number >= v_total_picks then 'complete' else 'in_progress' end,
         completed_at = case when p_pick_number >= v_total_picks then now() else null end
   where id = p_draft_id
   returning * into v_draft;

  return jsonb_build_object('pick', to_jsonb(v_pick), 'draft', to_jsonb(v_draft));
end;
$$;

create or replace function public.fsnv2_undo_pick(p_draft_id uuid)
returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare v_pick fsnv2.draft_picks; v_draft fsnv2.drafts;
begin
  delete from fsnv2.draft_picks
   where id = (select id from fsnv2.draft_picks where draft_id = p_draft_id
               order by pick_number desc limit 1)
   returning * into v_pick;
  if not found then return null; end if;

  update fsnv2.drafts
     set current_pick = v_pick.pick_number, status = 'in_progress', completed_at = null
   where id = p_draft_id returning * into v_draft;

  return jsonb_build_object('pick', to_jsonb(v_pick), 'draft', to_jsonb(v_draft));
end;
$$;

create or replace function public.fsnv2_reset_draft(p_draft_id uuid)
returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare v_draft fsnv2.drafts;
begin
  delete from fsnv2.draft_picks where draft_id = p_draft_id;
  update fsnv2.drafts
     set current_pick = 1, status = 'in_progress', started_at = now(), completed_at = null
   where id = p_draft_id returning * into v_draft;
  return to_jsonb(v_draft);
end;
$$;

-- Full board hydrate: draft row, league row and every pick made so far.
create or replace function public.fsnv2_draft_state(p_draft_id uuid)
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select jsonb_build_object(
    'draft',  to_jsonb(d),
    'league', to_jsonb(l),
    'picks',  coalesce((
      select jsonb_agg(to_jsonb(p) order by p.pick_number)
      from fsnv2.draft_picks p where p.draft_id = d.id
    ), '[]'::jsonb)
  )
  from fsnv2.drafts d
  join fsnv2.leagues l on l.id = d.league_id
  where d.id = p_draft_id;
$$;

create or replace function public.fsnv2_players(p_limit integer default 1000)
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.adp), '[]'::jsonb)
  from (select * from fsnv2.players order by adp limit p_limit) p;
$$;

create or replace function public.fsnv2_leagues()
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'league', to_jsonb(l),
    'drafts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'status', d.status, 'current_pick', d.current_pick,
        'rounds', d.rounds, 'timer_seconds', d.timer_seconds,
        'picks_made', (select count(*) from fsnv2.draft_picks dp where dp.draft_id = d.id)
      ) order by d.created_at desc)
      from fsnv2.drafts d where d.league_id = l.id
    ), '[]'::jsonb)
  ) order by l.created_at desc), '[]'::jsonb)
  from fsnv2.leagues l;
$$;

grant usage on schema fsnv2 to anon, authenticated;
grant execute on function
  public.fsnv2_snake_team(integer, integer, text),
  public.fsnv2_create_league(text, integer, text, jsonb),
  public.fsnv2_start_draft(uuid, integer, integer, jsonb),
  public.fsnv2_upsert_players(jsonb),
  public.fsnv2_record_pick(uuid, integer, text, integer, boolean, text),
  public.fsnv2_undo_pick(uuid),
  public.fsnv2_reset_draft(uuid),
  public.fsnv2_draft_state(uuid),
  public.fsnv2_players(integer),
  public.fsnv2_leagues()
to anon, authenticated;
