-- =============================================================================
-- FSN v2 — Current team affiliations
-- Apply to the Supabase project `FSN` as migration `fsnv2_player_team_refresh`.
--
-- The bug: player profiles showed a former club (Kyler Murray as ARI, David
-- Montgomery as DET) even though the roster sync had the current one. Two
-- distinct causes, both fixed here:
--
--  1. fsnv2.players holds two pools. The provider pool (provider = 'tank01',
--     id '<provider>-<external_id>') is refreshed from the live rosters and was
--     already correct — MIN and HOU respectively. The synthetic pool from
--     js/playerData.js (provider null, id 'p-0007') is what the draft board and
--     every UI surface actually read, and nothing ever refreshed its `team`.
--     fsnv2_refresh_player_teams() now patches those rows from the synced pool,
--     matching on normalised name + position, and fsnv2_sync_players calls it
--     at the end of every player sync so an affiliation can never go stale
--     again by more than one sync cycle.
--
--  2. The browser re-pushes its local pool through fsnv2_upsert_players on
--     every page load (js/app.js), which wrote the static file's team straight
--     back over a freshly synced one. That upsert now defers to the provider
--     pool for `team` whenever a synced row matches the player, so the static
--     file can no longer undo a sync. Everything else it writes (ADP, VOR,
--     projections, tiers) is unchanged: those belong to the draft engine.
--
-- Also here: fsnv2_team_abbr(), one canonical spelling per franchise. Tank01
-- sends Washington as 'WSH' while the app keys its colours, logos and slate on
-- 'WAS', so a synced Commanders player rendered as a grey chip with no logo and
-- no opponent. The same alias table lives in lib/services/normalize.ts (new
-- rows) and js/nflTeams.js (rendering); this one canonicalises what is already
-- stored, and is applied by both upserts on the way in.
-- =============================================================================

-- ------------------------------------------------------- canonical abbrev --
create or replace function public.fsnv2_team_abbr(p_abbr text)
returns text
language sql immutable as $$
  select case upper(nullif(btrim(coalesce(p_abbr, '')), ''))
    when 'ARZ' then 'ARI'
    when 'BLT' then 'BAL'
    when 'CLV' then 'CLE'
    when 'GNB' then 'GB'
    when 'HST' then 'HOU'
    when 'JAC' then 'JAX'
    when 'JAG' then 'JAX'
    when 'KAN' then 'KC'
    when 'LA'  then 'LAR'
    when 'LVR' then 'LV'
    when 'NOR' then 'NO'
    when 'NWE' then 'NE'
    when 'OAK' then 'LV'
    when 'SD'  then 'LAC'
    when 'SDG' then 'LAC'
    when 'SFO' then 'SF'
    when 'STL' then 'LAR'
    when 'TAM' then 'TB'
    when 'WFT' then 'WAS'
    when 'WSH' then 'WAS'
    else upper(nullif(btrim(coalesce(p_abbr, '')), ''))
  end;
$$;

comment on function public.fsnv2_team_abbr(text) is
  'One canonical abbreviation per franchise (WSH -> WAS, JAC -> JAX, OAK -> LV …). '
  'Mirrors TEAM_ALIASES in lib/services/normalize.ts and js/nflTeams.js.';

-- ------------------------------------------------- match key for a player --
-- Punctuation, spacing and case differ between the static pool and the feed
-- ("Wan'Dale Robinson", "Travis Etienne Jr."), so both sides are reduced to
-- letters and digits before they are compared.
create or replace function public.fsnv2_player_key(p_name text)
returns text
language sql immutable as $$
  select lower(regexp_replace(coalesce(p_name, ''), '[^a-zA-Z0-9]', '', 'g'));
$$;

-- ------------------------------------------- refresh synthetic affiliations --
-- Copies team + nfl_team_external_id from the freshest provider row onto every
-- row that has no provider of its own. Returns what it touched, so the sync
-- log and a manual run both say how many players moved.
create or replace function public.fsnv2_refresh_player_teams()
returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_moved   integer := 0;
  v_matched integer := 0;
begin
  with synced as (
    select distinct on (public.fsnv2_player_key(name), position)
           public.fsnv2_player_key(name)        as match_key,
           position,
           public.fsnv2_team_abbr(team)         as team,
           nfl_team_external_id,
           bye_week
      from fsnv2.players
     where provider is not null
       and coalesce(team, '') not in ('', 'FA')
     order by public.fsnv2_player_key(name), position, synced_at desc nulls last
  ), legacy as (
    select p.id, p.team as old_team, s.team as new_team,
           s.nfl_team_external_id, s.bye_week
      from fsnv2.players p
      join synced s
        on s.match_key = public.fsnv2_player_key(p.name)
       and s.position = p.position
     where p.provider is null
  ), moved as (
    update fsnv2.players p
       set team = l.new_team,
           nfl_team_external_id = coalesce(l.nfl_team_external_id, p.nfl_team_external_id),
           bye_week = coalesce(l.bye_week, p.bye_week),
           updated_at = now()
      from legacy l
     where p.id = l.id
       and (p.team is distinct from l.new_team
            or p.nfl_team_external_id is distinct from
               coalesce(l.nfl_team_external_id, p.nfl_team_external_id))
    returning 1
  )
  select (select count(*) from moved), (select count(*) from legacy)
    into v_moved, v_matched;

  return jsonb_build_object('matched', v_matched, 'moved', v_moved);
end;
$$;

comment on function public.fsnv2_refresh_player_teams() is
  'Patches provider-less player rows with the current team of the matching synced player.';

-- --------------------------------------------------- the browser-side pool --
-- Same contract as before (0002) with one change: `team` is taken from the
-- synced provider pool when that pool knows this player, so re-pushing
-- js/playerData.js can no longer write a former club back over a synced one.
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
      public.fsnv2_team_abbr(p ->> 'team') as team,
      coalesce((p ->> 'adp')::numeric, 999) as adp,
      coalesce(p -> 'stats', '{}'::jsonb)   as stats
    from jsonb_array_elements(p_players) as p
  ), current_teams as (
    select distinct on (public.fsnv2_player_key(name), position)
           public.fsnv2_player_key(name) as match_key,
           position,
           public.fsnv2_team_abbr(team)  as team,
           nfl_team_external_id
      from fsnv2.players
     where provider is not null
       and coalesce(team, '') not in ('', 'FA')
     order by public.fsnv2_player_key(name), position, synced_at desc nulls last
  ), resolved as (
    select r.id, r.name, r.position,
           coalesce(c.team, r.team) as team,
           c.nfl_team_external_id,
           r.adp, r.stats
      from rows r
      left join current_teams c
        on c.match_key = public.fsnv2_player_key(r.name)
       and c.position = r.position
  ), upserted as (
    insert into fsnv2.players (id, name, position, team, nfl_team_external_id, adp, stats)
    select id, name, position, team, nfl_team_external_id, adp, stats from resolved
    on conflict (id) do update
      set name = excluded.name, position = excluded.position, team = excluded.team,
          nfl_team_external_id =
            coalesce(excluded.nfl_team_external_id, fsnv2.players.nfl_team_external_id),
          adp = excluded.adp, stats = excluded.stats, updated_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$$;

-- ---------------------------------------------------------- the sync pool --
-- As in 0004/0005, with two changes: team abbreviations are canonicalised on
-- the way in, and the synthetic pool is refreshed from this one once the batch
-- has landed.
create or replace function public.fsnv2_sync_players(
  p_provider text,
  p_players  jsonb
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_bad      integer;
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_total    integer;
  v_refresh  jsonb;
begin
  if p_provider is null or p_provider = '' then
    raise exception 'fsnv2_sync_players: provider is required' using errcode = 'P0001';
  end if;
  if p_players is null or jsonb_typeof(p_players) <> 'array' then
    raise exception 'fsnv2_sync_players: p_players must be a jsonb array, got %',
      coalesce(jsonb_typeof(p_players), 'null') using errcode = 'P0001';
  end if;

  select count(*) into v_bad
    from jsonb_array_elements(p_players) p
   where coalesce(p ->> 'external_id', '') = '' or coalesce(p ->> 'name', '') = '';
  if v_bad > 0 then
    raise exception 'fsnv2_sync_players: % row(s) missing external_id or name', v_bad
      using errcode = 'P0001';
  end if;

  select count(*) into v_total from jsonb_array_elements(p_players);

  with src as (
    select
      coalesce(nullif(p ->> 'id', ''), p_provider || '-' || (p ->> 'external_id')) as id,
      (p ->> 'external_id')                as external_id,
      (p ->> 'name')                       as name,
      upper(p ->> 'position')              as position,
      coalesce(public.fsnv2_team_abbr(p ->> 'team'), 'FA') as team,
      nullif(p ->> 'nfl_team_external_id', '') as nfl_team_external_id,
      coalesce(nullif(p ->> 'adp', '')::numeric, 999) as adp,
      coalesce(p -> 'stats', '{}'::jsonb)  as stats,
      nullif(p ->> 'jersey', '')           as jersey,
      nullif(p ->> 'status', '')           as status,
      coalesce(p -> 'injury', '{}'::jsonb) as injury,
      nullif(p ->> 'bye_week', '')::integer as bye_week,
      nullif(p ->> 'age', '')::numeric     as age,
      nullif(p ->> 'experience', '')       as experience,
      nullif(p ->> 'college', '')          as college
    from jsonb_array_elements(p_players) p
  ), eligible as (
    select * from src where position in ('QB','RB','WR','TE','K','DST')
  ), upserted as (
    insert into fsnv2.players
      (id, name, position, team, adp, stats, provider, external_id, nfl_team_external_id,
       jersey, status, injury, bye_week, age, experience, college, synced_at)
    select id, name, position, team, adp, stats, p_provider, external_id, nfl_team_external_id,
           jersey, status, injury, bye_week, age, experience, college, now()
      from eligible
    on conflict (provider, external_id) do update
      -- The roster the sync read this player from is his affiliation: team and
      -- nfl_team_external_id are always overwritten, never coalesced.
      set name = excluded.name, position = excluded.position, team = excluded.team,
          adp = case when excluded.adp = 999 then fsnv2.players.adp else excluded.adp end,
          stats = fsnv2.players.stats || excluded.stats,
          nfl_team_external_id = excluded.nfl_team_external_id,
          jersey = excluded.jersey, status = excluded.status, injury = excluded.injury,
          bye_week = excluded.bye_week, age = excluded.age,
          experience = excluded.experience, college = excluded.college,
          synced_at = now(), updated_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
    from upserted;

  -- Carry the refreshed affiliations across to the pool the UI reads.
  v_refresh := public.fsnv2_refresh_player_teams();

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated,
    'skipped', v_total - v_inserted - v_updated, 'total', v_total,
    'refreshed', v_refresh);
end;
$$;

-- ------------------------------------------------------------------ grants --
grant execute on function
  public.fsnv2_team_abbr(text),
  public.fsnv2_player_key(text)
to anon, authenticated, service_role;

grant execute on function public.fsnv2_upsert_players(jsonb) to anon, authenticated;

grant execute on function
  public.fsnv2_sync_players(text, jsonb),
  public.fsnv2_refresh_player_teams()
to service_role;

revoke execute on function
  public.fsnv2_sync_players(text, jsonb),
  public.fsnv2_refresh_player_teams()
from anon, authenticated, public;

-- =============================================================================
-- Backfill — the patch for rows written before this migration.
-- =============================================================================

-- One spelling per franchise, everywhere an abbreviation is stored.
update fsnv2.players
   set team = public.fsnv2_team_abbr(team), updated_at = now()
 where team is distinct from public.fsnv2_team_abbr(team);

update fsnv2.projections
   set team = public.fsnv2_team_abbr(team),
       opponent = public.fsnv2_team_abbr(opponent)
 where team is distinct from public.fsnv2_team_abbr(team)
    or opponent is distinct from public.fsnv2_team_abbr(opponent);

update fsnv2.weekly_stats
   set team = public.fsnv2_team_abbr(team),
       opponent = public.fsnv2_team_abbr(opponent)
 where team is distinct from public.fsnv2_team_abbr(team)
    or opponent is distinct from public.fsnv2_team_abbr(opponent);

update fsnv2.nfl_matchups
   set home_team = public.fsnv2_team_abbr(home_team),
       away_team = public.fsnv2_team_abbr(away_team)
 where home_team is distinct from public.fsnv2_team_abbr(home_team)
    or away_team is distinct from public.fsnv2_team_abbr(away_team);

-- nfl_teams is unique on (provider, abbr): only rewrite where the canonical
-- spelling is not already taken by another row for the same provider.
update fsnv2.nfl_teams t
   set abbr = public.fsnv2_team_abbr(t.abbr), updated_at = now()
 where t.abbr is distinct from public.fsnv2_team_abbr(t.abbr)
   and not exists (
     select 1 from fsnv2.nfl_teams o
      where o.provider = t.provider
        and o.abbr = public.fsnv2_team_abbr(t.abbr)
        and o.id <> t.id
   );

-- And the affiliations themselves.
select public.fsnv2_refresh_player_teams();
