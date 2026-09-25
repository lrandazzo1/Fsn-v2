-- =============================================================================
-- FSN v2 — Keeping roster affiliations live
-- Apply to the Supabase project `FSN` as migration `fsnv2_player_team_refresh`.
--
-- This migration captures helpers that were applied directly to the live
-- database while chasing a mid-season roster problem, and which until now
-- existed nowhere in git. Re-running migrations 0001-0005 on a fresh project
-- produced a database *without* them, which silently reintroduced the bug they
-- fix. Everything below is written to be idempotent, so applying it to the
-- project that already has these functions is a no-op.
--
-- The problem
-- -----------
-- fsnv2.players holds two kinds of row:
--
--   provider is null   the browser's own draft pool (js/playerData.js), keyed
--                      `p-0000`, carrying adp / projection / VOR in `stats`.
--   provider is set    the sports-data sync (`tank01-4035538`), carrying the
--                      real roster: team, bye week, jersey, injury.
--
-- The app pushes its pool up on every boot through fsnv2_upsert_players(). The
-- original version wrote `team = excluded.team` unconditionally, so each boot
-- overwrote the synced roster with whatever the static file happened to say.
-- Mid-season moves — Kyler Murray to MIN, David Montgomery to HOU — were
-- clobbered back to ARI and DET within seconds of a page load.
--
-- The fix has two halves:
--
--   fsnv2_upsert_players()        never lets a static row downgrade a team that
--                                 the sync already established (write side).
--   fsnv2_refresh_player_teams()  pushes synced teams onto the legacy rows that
--                                 already exist (repair side; run after a sync).
--
-- Both match a provider row to a static row on (normalised name, position),
-- because the two id spaces do not overlap.
-- =============================================================================

-- --------------------------------------------------------------- matching --
-- Names arrive punctuated inconsistently between the provider and the static
-- pool ("Ja'Marr Chase" / "JaMarr Chase", "A.J. Brown" / "AJ Brown"). Strip
-- everything that is not a letter or a digit and compare what is left.
--
-- IMMUTABLE so it can be used in the distinct-on / join keys below.
create or replace function public.fsnv2_player_key(p_name text)
returns text
language sql immutable as $$
  select lower(regexp_replace(coalesce(p_name, ''), '[^a-zA-Z0-9]', '', 'g'));
$$;

-- ----------------------------------------------------------------- aliases --
-- Providers disagree about a dozen abbreviations, and the app's 32-team key set
-- (js/nflTeams.js) only knows one spelling of each. Fold every variant onto the
-- canonical key so a team never splits into two franchises halfway down a join.
-- Anything unrecognised passes through upper-cased rather than becoming null.
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

-- ------------------------------------------------------- pool upsert (write) --
-- Replaces the 0002 definition. Two changes from the original:
--
--   1. every incoming team is normalised through fsnv2_team_abbr();
--   2. `resolved` prefers the team the sync established over the one the
--      browser sent, so a stale static row can no longer clobber a live roster.
--
-- adp / stats still come from the caller — those are the browser's numbers and
-- the sync has nothing better to offer. A player the sync has never seen keeps
-- the team the caller sent, so an offline-only deployment behaves as before.
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
    -- The most recently synced provider row per (name, position).
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

-- ------------------------------------------------------ pool repair (read-fix) --
-- The write-side guard only protects rows going up. This walks the legacy rows
-- already sitting in the table and moves each onto the team its synced twin is
-- on. Run it after `npm run sync:data players`; the weekly cron does exactly
-- that. Safe to run repeatedly — it only touches rows that actually differ.
--
-- Returns {"matched": n, "moved": n}: how many legacy rows had a synced twin,
-- and how many of those were on the wrong team.
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

-- ------------------------------------------------------------------ grants --
-- fsnv2_player_key / fsnv2_team_abbr are pure string helpers with no table
-- access; the browser calls neither directly, but they appear inside RPCs that
-- anon executes, so EXECUTE has to be there. fsnv2_upsert_players keeps the
-- 0002 grant (the app pushes its pool up with the publishable key).
--
-- fsnv2_refresh_player_teams is a write against every legacy row: service_role
-- only, like the rest of the sync surface.
grant execute on function
  public.fsnv2_player_key(text),
  public.fsnv2_team_abbr(text),
  public.fsnv2_upsert_players(jsonb)
to anon, authenticated, service_role;

grant execute on function
  public.fsnv2_refresh_player_teams()
to service_role;

revoke execute on function
  public.fsnv2_refresh_player_teams()
from anon, authenticated, public;

-- ---------------------------------------------------------------- backfill --
-- Normalise any abbreviation written before fsnv2_team_abbr existed, then run
-- the repair once so the table leaves this migration in the state the guard
-- above will keep it in.
update fsnv2.players
   set team = public.fsnv2_team_abbr(team), updated_at = now()
 where team is not null and team <> public.fsnv2_team_abbr(team);

update fsnv2.projections
   set opponent = public.fsnv2_team_abbr(opponent), updated_at = now()
 where opponent is not null and opponent <> public.fsnv2_team_abbr(opponent);

update fsnv2.nfl_matchups
   set home_team = public.fsnv2_team_abbr(home_team),
       away_team = public.fsnv2_team_abbr(away_team),
       updated_at = now()
 where home_team <> public.fsnv2_team_abbr(home_team)
    or away_team <> public.fsnv2_team_abbr(away_team);

select public.fsnv2_refresh_player_teams();
