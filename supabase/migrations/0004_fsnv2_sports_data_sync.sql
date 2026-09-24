-- =============================================================================
-- FSN v2 — Sports-data ingestion (Phase 3)
-- Apply to the Supabase project `FSN` as migration `fsnv2_sports_data_sync`.
--
-- Phase 1 and 2 ran on the synthetic pool in js/playerData.js. This migration
-- gives the background sync service somewhere to land real provider data:
--
--   fsnv2.nfl_teams      the 32 franchises (rosters hang off players.provider_*)
--   fsnv2.players        extended in place with provider identity + roster fields
--   fsnv2.projections    one row per player per week per scoring format
--   fsnv2.weekly_stats   the real box score — one row per player per week
--   fsnv2.nfl_matchups   the NFL schedule (see the note below)
--   fsnv2.sync_runs      an audit row per sync attempt, success or failure
--
-- NOTE on `matchups`: fsnv2.matchups (0003) is the *fantasy* head-to-head
-- schedule — league-scoped, with integer franchise slots 1..12 and the unique
-- constraints the season generator asserts against. Real NFL games have none of
-- that shape, so they land in fsnv2.nfl_matchups rather than being forced into
-- a table the season engine owns. Both are read through RPCs, so UI code never
-- has to know which is which.
--
-- Write RPCs are granted to `service_role` only: the sync service runs
-- server-side with the secret key, and nothing in the browser should be able to
-- rewrite projections. The read RPCs stay open to anon/authenticated like the
-- rest of the Phase 1/2 surface.
-- =============================================================================

-- --------------------------------------------------------------- nfl_teams --
create table if not exists fsnv2.nfl_teams (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,
  external_id text not null,
  abbr        text not null,
  city        text,
  name        text,
  conference  text,
  division    text,
  bye_week    integer check (bye_week between 1 and 22),
  logo_url    text,
  raw         jsonb not null default '{}'::jsonb,
  synced_at   timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint nfl_teams_unique_external unique (provider, external_id),
  constraint nfl_teams_unique_abbr     unique (provider, abbr)
);

-- ------------------------------------------------- players: provider fields --
-- Added in place so the draft board keeps working: js/playerData.js rows stay
-- exactly as they are (provider/external_id null) and synced rows sit beside
-- them, keyed '<provider>-<external_id>'.
alter table fsnv2.players add column if not exists provider             text;
alter table fsnv2.players add column if not exists external_id          text;
alter table fsnv2.players add column if not exists nfl_team_external_id text;
alter table fsnv2.players add column if not exists jersey               text;
alter table fsnv2.players add column if not exists status               text;
alter table fsnv2.players add column if not exists injury               jsonb not null default '{}'::jsonb;
alter table fsnv2.players add column if not exists bye_week             integer;
alter table fsnv2.players add column if not exists age                  numeric(5,2);
alter table fsnv2.players add column if not exists experience           text;
alter table fsnv2.players add column if not exists college              text;
alter table fsnv2.players add column if not exists synced_at            timestamptz;

-- NULLs are distinct in a unique constraint, so the 200-odd synthetic rows
-- (provider null) never collide with each other or with provider rows.
do $$
begin
  alter table fsnv2.players
    add constraint players_unique_external unique (provider, external_id);
exception
  when duplicate_table or duplicate_object then null;
end;
$$;

create index if not exists players_team_idx on fsnv2.players (team);

-- ------------------------------------------------------------- projections --
-- Weekly fantasy projections. Deliberately no FK to fsnv2.players: a provider
-- can publish a projection for a player the roster sync has not reached yet,
-- and a half-finished player sync must never reject a projection batch (the
-- same reasoning as player_week_scores in 0003).
create table if not exists fsnv2.projections (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null,
  external_player_id text not null,
  player_id          text,
  season             integer not null check (season between 1920 and 2100),
  week               integer not null check (week between 0 and 22),
  season_type        text not null default 'reg'
                       check (season_type in ('pre','reg','post')),
  scoring_format     text not null default 'ppr'
                       check (scoring_format in ('standard','half_ppr','ppr','superflex','custom')),
  name               text,
  position           text,
  team               text,
  opponent           text,
  fantasy_points     numeric(7,2) not null default 0,
  stats              jsonb not null default '{}'::jsonb,
  raw                jsonb not null default '{}'::jsonb,
  source             text,
  synced_at          timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint projections_unique
    unique (provider, season, season_type, week, scoring_format, external_player_id)
);
create index if not exists projections_week_idx
  on fsnv2.projections (season, season_type, week);
create index if not exists projections_player_idx on fsnv2.projections (player_id);
create index if not exists projections_points_idx
  on fsnv2.projections (season, week, fantasy_points desc);

-- ------------------------------------------------------------ weekly_stats --
-- The real box score behind a week: actual fantasy points plus the raw stat
-- lines. Same no-FK rule as projections.
create table if not exists fsnv2.weekly_stats (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null,
  external_player_id text not null,
  player_id          text,
  season             integer not null check (season between 1920 and 2100),
  week               integer not null check (week between 0 and 22),
  season_type        text not null default 'reg'
                       check (season_type in ('pre','reg','post')),
  game_external_id   text,
  name               text,
  position           text,
  team               text,
  opponent           text,
  fantasy_points     numeric(7,2) not null default 0,
  stats              jsonb not null default '{}'::jsonb,
  snap_counts        jsonb not null default '{}'::jsonb,
  raw                jsonb not null default '{}'::jsonb,
  source             text,
  synced_at          timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint weekly_stats_unique
    unique (provider, season, season_type, week, external_player_id)
);
create index if not exists weekly_stats_week_idx
  on fsnv2.weekly_stats (season, season_type, week);
create index if not exists weekly_stats_game_idx on fsnv2.weekly_stats (game_external_id);
create index if not exists weekly_stats_player_idx on fsnv2.weekly_stats (player_id);

-- ----------------------------------------------------------- nfl_matchups --
create table if not exists fsnv2.nfl_matchups (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null,
  external_id  text not null,
  season       integer not null check (season between 1920 and 2100),
  week         integer not null check (week between 0 and 22),
  season_type  text not null default 'reg' check (season_type in ('pre','reg','post')),
  home_team    text not null,
  away_team    text not null,
  home_score   numeric(6,2),
  away_score   numeric(6,2),
  kickoff      timestamptz,
  status       text not null default 'scheduled'
                 check (status in ('scheduled','in_progress','final','postponed','canceled')),
  venue        text,
  neutral_site boolean not null default false,
  raw          jsonb not null default '{}'::jsonb,
  source       text,
  synced_at    timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint nfl_matchups_unique_external unique (provider, external_id),
  constraint nfl_matchups_distinct_teams  check (home_team <> away_team)
);
create index if not exists nfl_matchups_week_idx
  on fsnv2.nfl_matchups (season, season_type, week);

-- --------------------------------------------------------------- sync_runs --
-- One row per sync attempt. The service writes 'success' / 'partial' / 'error'
-- with the provider error text attached, so a failed overnight run is visible
-- in the database instead of only in a log the container threw away.
create table if not exists fsnv2.sync_runs (
  id          uuid primary key default gen_random_uuid(),
  task        text not null
                check (task in ('players_rosters','weekly_projections','box_scores','schedules')),
  provider    text not null,
  season      integer,
  week        integer,
  status      text not null check (status in ('running','success','partial','error')),
  fetched     integer not null default 0,
  written     integer not null default 0,
  skipped     integer not null default 0,
  duration_ms integer,
  error       text,
  detail      jsonb not null default '{}'::jsonb,
  started_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists sync_runs_task_idx on fsnv2.sync_runs (task, started_at desc);

-- ------------------------------------------------------------- updated_at ---
drop trigger if exists nfl_teams_touch on fsnv2.nfl_teams;
create trigger nfl_teams_touch before update on fsnv2.nfl_teams
  for each row execute function fsnv2.touch_updated_at();

drop trigger if exists projections_touch on fsnv2.projections;
create trigger projections_touch before update on fsnv2.projections
  for each row execute function fsnv2.touch_updated_at();

drop trigger if exists weekly_stats_touch on fsnv2.weekly_stats;
create trigger weekly_stats_touch before update on fsnv2.weekly_stats
  for each row execute function fsnv2.touch_updated_at();

drop trigger if exists nfl_matchups_touch on fsnv2.nfl_matchups;
create trigger nfl_matchups_touch before update on fsnv2.nfl_matchups
  for each row execute function fsnv2.touch_updated_at();

-- RLS on, no direct-table policies — everything goes through the RPCs below.
alter table fsnv2.nfl_teams    enable row level security;
alter table fsnv2.projections  enable row level security;
alter table fsnv2.weekly_stats enable row level security;
alter table fsnv2.nfl_matchups enable row level security;
alter table fsnv2.sync_runs    enable row level security;

-- =============================================================================
-- Write RPCs — one per sync step, every one an UPSERT.
--
-- Each takes the provider name plus a jsonb array of already-normalised rows
-- (lib/services/sportsData.ts does the provider-specific mapping) and returns
--   {"inserted": n, "updated": n, "skipped": n, "total": n}
-- so the caller can log exactly what a batch did. Re-running a batch is a
-- no-op beyond refreshed values: nothing duplicates.
-- =============================================================================

create or replace function public.fsnv2_sync_nfl_teams(
  p_provider text,
  p_teams    jsonb
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_bad      integer;
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_total    integer;
begin
  if p_provider is null or p_provider = '' then
    raise exception 'fsnv2_sync_nfl_teams: provider is required' using errcode = 'P0001';
  end if;
  if p_teams is null or jsonb_typeof(p_teams) <> 'array' then
    raise exception 'fsnv2_sync_nfl_teams: p_teams must be a jsonb array, got %',
      coalesce(jsonb_typeof(p_teams), 'null') using errcode = 'P0001';
  end if;

  select count(*) into v_bad
    from jsonb_array_elements(p_teams) t
   where coalesce(t ->> 'external_id', '') = '' or coalesce(t ->> 'abbr', '') = '';
  if v_bad > 0 then
    raise exception 'fsnv2_sync_nfl_teams: % row(s) missing external_id or abbr', v_bad
      using errcode = 'P0001';
  end if;

  select count(*) into v_total from jsonb_array_elements(p_teams);

  with src as (
    select
      (t ->> 'external_id')            as external_id,
      upper(t ->> 'abbr')              as abbr,
      nullif(t ->> 'city', '')         as city,
      nullif(t ->> 'name', '')         as name,
      nullif(t ->> 'conference', '')   as conference,
      nullif(t ->> 'division', '')     as division,
      nullif(t ->> 'bye_week', '')::integer as bye_week,
      nullif(t ->> 'logo_url', '')     as logo_url,
      coalesce(t -> 'raw', '{}'::jsonb) as raw
    from jsonb_array_elements(p_teams) t
  ), upserted as (
    insert into fsnv2.nfl_teams
      (provider, external_id, abbr, city, name, conference, division, bye_week, logo_url, raw, synced_at)
    select p_provider, external_id, abbr, city, name, conference, division, bye_week, logo_url, raw, now()
      from src
    on conflict (provider, external_id) do update
      set abbr = excluded.abbr, city = excluded.city, name = excluded.name,
          conference = excluded.conference, division = excluded.division,
          bye_week = excluded.bye_week, logo_url = excluded.logo_url,
          raw = excluded.raw, synced_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
    from upserted;

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated,
    'skipped', v_total - v_inserted - v_updated, 'total', v_total);
end;
$$;

-- Players + rosters. Rows whose position the draft board does not carry
-- (offensive line, linebackers, …) are skipped rather than failing the batch —
-- fsnv2.players is a fantasy pool, not an NFL depth chart.
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
      coalesce(upper(nullif(p ->> 'team', '')), 'FA') as team,
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

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated,
    'skipped', v_total - v_inserted - v_updated, 'total', v_total);
end;
$$;

create or replace function public.fsnv2_sync_projections(
  p_provider text,
  p_rows     jsonb
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_bad      integer;
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_total    integer;
begin
  if p_provider is null or p_provider = '' then
    raise exception 'fsnv2_sync_projections: provider is required' using errcode = 'P0001';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'fsnv2_sync_projections: p_rows must be a jsonb array, got %',
      coalesce(jsonb_typeof(p_rows), 'null') using errcode = 'P0001';
  end if;

  select count(*) into v_bad
    from jsonb_array_elements(p_rows) r
   where coalesce(r ->> 'external_player_id', '') = ''
      or coalesce(r ->> 'season', '') = ''
      or coalesce(r ->> 'week', '') = '';
  if v_bad > 0 then
    raise exception 'fsnv2_sync_projections: % row(s) missing external_player_id, season or week', v_bad
      using errcode = 'P0001';
  end if;

  select count(*) into v_total from jsonb_array_elements(p_rows);

  with src as (
    select distinct on (
        (r ->> 'external_player_id'), (r ->> 'season')::integer, (r ->> 'week')::integer,
        coalesce(nullif(r ->> 'season_type', ''), 'reg'),
        coalesce(nullif(r ->> 'scoring_format', ''), 'ppr'))
      (r ->> 'external_player_id')            as external_player_id,
      nullif(r ->> 'player_id', '')           as player_id,
      (r ->> 'season')::integer               as season,
      (r ->> 'week')::integer                 as week,
      coalesce(nullif(r ->> 'season_type', ''), 'reg')    as season_type,
      coalesce(nullif(r ->> 'scoring_format', ''), 'ppr') as scoring_format,
      nullif(r ->> 'name', '')                as name,
      upper(nullif(r ->> 'position', ''))     as position,
      upper(nullif(r ->> 'team', ''))         as team,
      upper(nullif(r ->> 'opponent', ''))     as opponent,
      coalesce(nullif(r ->> 'fantasy_points', '')::numeric, 0) as fantasy_points,
      coalesce(r -> 'stats', '{}'::jsonb)     as stats,
      coalesce(r -> 'raw', '{}'::jsonb)       as raw,
      nullif(r ->> 'source', '')              as source
    from jsonb_array_elements(p_rows) r
  ), upserted as (
    insert into fsnv2.projections
      (provider, external_player_id, player_id, season, week, season_type, scoring_format,
       name, position, team, opponent, fantasy_points, stats, raw, source, synced_at)
    select p_provider, external_player_id, player_id, season, week, season_type, scoring_format,
           name, position, team, opponent, fantasy_points, stats, raw, source, now()
      from src
    on conflict (provider, season, season_type, week, scoring_format, external_player_id) do update
      set player_id = coalesce(excluded.player_id, fsnv2.projections.player_id),
          name = excluded.name, position = excluded.position,
          team = excluded.team, opponent = excluded.opponent,
          fantasy_points = excluded.fantasy_points, stats = excluded.stats,
          raw = excluded.raw, source = excluded.source, synced_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
    from upserted;

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated,
    'skipped', v_total - v_inserted - v_updated, 'total', v_total);
end;
$$;

create or replace function public.fsnv2_sync_weekly_stats(
  p_provider text,
  p_rows     jsonb
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_bad      integer;
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_total    integer;
begin
  if p_provider is null or p_provider = '' then
    raise exception 'fsnv2_sync_weekly_stats: provider is required' using errcode = 'P0001';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'fsnv2_sync_weekly_stats: p_rows must be a jsonb array, got %',
      coalesce(jsonb_typeof(p_rows), 'null') using errcode = 'P0001';
  end if;

  select count(*) into v_bad
    from jsonb_array_elements(p_rows) r
   where coalesce(r ->> 'external_player_id', '') = ''
      or coalesce(r ->> 'season', '') = ''
      or coalesce(r ->> 'week', '') = '';
  if v_bad > 0 then
    raise exception 'fsnv2_sync_weekly_stats: % row(s) missing external_player_id, season or week', v_bad
      using errcode = 'P0001';
  end if;

  select count(*) into v_total from jsonb_array_elements(p_rows);

  with src as (
    select distinct on (
        (r ->> 'external_player_id'), (r ->> 'season')::integer, (r ->> 'week')::integer,
        coalesce(nullif(r ->> 'season_type', ''), 'reg'))
      (r ->> 'external_player_id')          as external_player_id,
      nullif(r ->> 'player_id', '')         as player_id,
      (r ->> 'season')::integer             as season,
      (r ->> 'week')::integer               as week,
      coalesce(nullif(r ->> 'season_type', ''), 'reg') as season_type,
      nullif(r ->> 'game_external_id', '')  as game_external_id,
      nullif(r ->> 'name', '')              as name,
      upper(nullif(r ->> 'position', ''))   as position,
      upper(nullif(r ->> 'team', ''))       as team,
      upper(nullif(r ->> 'opponent', ''))   as opponent,
      coalesce(nullif(r ->> 'fantasy_points', '')::numeric, 0) as fantasy_points,
      coalesce(r -> 'stats', '{}'::jsonb)       as stats,
      coalesce(r -> 'snap_counts', '{}'::jsonb) as snap_counts,
      coalesce(r -> 'raw', '{}'::jsonb)         as raw,
      nullif(r ->> 'source', '')            as source
    from jsonb_array_elements(p_rows) r
  ), upserted as (
    insert into fsnv2.weekly_stats
      (provider, external_player_id, player_id, season, week, season_type, game_external_id,
       name, position, team, opponent, fantasy_points, stats, snap_counts, raw, source, synced_at)
    select p_provider, external_player_id, player_id, season, week, season_type, game_external_id,
           name, position, team, opponent, fantasy_points, stats, snap_counts, raw, source, now()
      from src
    on conflict (provider, season, season_type, week, external_player_id) do update
      set player_id = coalesce(excluded.player_id, fsnv2.weekly_stats.player_id),
          game_external_id = excluded.game_external_id,
          name = excluded.name, position = excluded.position,
          team = excluded.team, opponent = excluded.opponent,
          fantasy_points = excluded.fantasy_points, stats = excluded.stats,
          snap_counts = excluded.snap_counts, raw = excluded.raw,
          source = excluded.source, synced_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
    from upserted;

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated,
    'skipped', v_total - v_inserted - v_updated, 'total', v_total);
end;
$$;

create or replace function public.fsnv2_sync_schedules(
  p_provider text,
  p_games    jsonb
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_bad      integer;
  v_inserted integer := 0;
  v_updated  integer := 0;
  v_total    integer;
begin
  if p_provider is null or p_provider = '' then
    raise exception 'fsnv2_sync_schedules: provider is required' using errcode = 'P0001';
  end if;
  if p_games is null or jsonb_typeof(p_games) <> 'array' then
    raise exception 'fsnv2_sync_schedules: p_games must be a jsonb array, got %',
      coalesce(jsonb_typeof(p_games), 'null') using errcode = 'P0001';
  end if;

  select count(*) into v_bad
    from jsonb_array_elements(p_games) g
   where coalesce(g ->> 'external_id', '') = ''
      or coalesce(g ->> 'season', '') = ''
      or coalesce(g ->> 'week', '') = ''
      or coalesce(g ->> 'home_team', '') = ''
      or coalesce(g ->> 'away_team', '') = ''
      or upper(g ->> 'home_team') = upper(g ->> 'away_team');
  if v_bad > 0 then
    raise exception 'fsnv2_sync_schedules: % game(s) missing external_id/season/week/teams or playing themselves', v_bad
      using errcode = 'P0001';
  end if;

  select count(*) into v_total from jsonb_array_elements(p_games);

  with src as (
    select distinct on ((g ->> 'external_id'))
      (g ->> 'external_id')              as external_id,
      (g ->> 'season')::integer          as season,
      (g ->> 'week')::integer            as week,
      coalesce(nullif(g ->> 'season_type', ''), 'reg') as season_type,
      upper(g ->> 'home_team')           as home_team,
      upper(g ->> 'away_team')           as away_team,
      nullif(g ->> 'home_score', '')::numeric as home_score,
      nullif(g ->> 'away_score', '')::numeric as away_score,
      nullif(g ->> 'kickoff', '')::timestamptz as kickoff,
      coalesce(nullif(g ->> 'status', ''), 'scheduled') as status,
      nullif(g ->> 'venue', '')          as venue,
      coalesce((g ->> 'neutral_site')::boolean, false) as neutral_site,
      coalesce(g -> 'raw', '{}'::jsonb)  as raw,
      nullif(g ->> 'source', '')         as source
    from jsonb_array_elements(p_games) g
  ), upserted as (
    insert into fsnv2.nfl_matchups
      (provider, external_id, season, week, season_type, home_team, away_team,
       home_score, away_score, kickoff, status, venue, neutral_site, raw, source, synced_at)
    select p_provider, external_id, season, week, season_type, home_team, away_team,
           home_score, away_score, kickoff, status, venue, neutral_site, raw, source, now()
      from src
    on conflict (provider, external_id) do update
      set season = excluded.season, week = excluded.week, season_type = excluded.season_type,
          home_team = excluded.home_team, away_team = excluded.away_team,
          home_score = excluded.home_score, away_score = excluded.away_score,
          kickoff = excluded.kickoff, status = excluded.status, venue = excluded.venue,
          neutral_site = excluded.neutral_site, raw = excluded.raw,
          source = excluded.source, synced_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
    from upserted;

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated,
    'skipped', v_total - v_inserted - v_updated, 'total', v_total);
end;
$$;

-- Audit row for one sync attempt. Called on the way out of every task, so a
-- failure leaves a trail in the database and not just in stdout.
create or replace function public.fsnv2_log_sync_run(
  p_task        text,
  p_provider    text,
  p_status      text,
  p_season      integer default null,
  p_week        integer default null,
  p_fetched     integer default 0,
  p_written     integer default 0,
  p_skipped     integer default 0,
  p_duration_ms integer default null,
  p_error       text    default null,
  p_detail      jsonb   default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path = fsnv2, public as $$
declare v_id uuid;
begin
  insert into fsnv2.sync_runs
    (task, provider, status, season, week, fetched, written, skipped, duration_ms, error, detail,
     finished_at)
  values
    (p_task, p_provider, p_status, p_season, p_week,
     coalesce(p_fetched, 0), coalesce(p_written, 0), coalesce(p_skipped, 0),
     p_duration_ms, left(p_error, 4000), coalesce(p_detail, '{}'::jsonb),
     case when p_status = 'running' then null else now() end)
  returning id into v_id;
  return v_id;
end;
$$;

-- =============================================================================
-- Read RPCs — what the UI calls. Same shape as fsnv2_players/fsnv2_matchups.
-- =============================================================================

create or replace function public.fsnv2_projections(
  p_season         integer,
  p_week           integer,
  p_scoring_format text default null,
  p_season_type    text default 'reg',
  p_limit          integer default 1000
) returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.fantasy_points desc), '[]'::jsonb)
  from (
    select * from fsnv2.projections
     where season = p_season and week = p_week
       and season_type = coalesce(p_season_type, 'reg')
       and (p_scoring_format is null or scoring_format = p_scoring_format)
     order by fantasy_points desc
     limit greatest(coalesce(p_limit, 1000), 1)
  ) p;
$$;

create or replace function public.fsnv2_weekly_stats(
  p_season      integer,
  p_week        integer,
  p_season_type text default 'reg',
  p_limit       integer default 1000
) returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(to_jsonb(w) order by w.fantasy_points desc), '[]'::jsonb)
  from (
    select * from fsnv2.weekly_stats
     where season = p_season and week = p_week
       and season_type = coalesce(p_season_type, 'reg')
     order by fantasy_points desc
     limit greatest(coalesce(p_limit, 1000), 1)
  ) w;
$$;

create or replace function public.fsnv2_nfl_schedule(
  p_season      integer,
  p_week        integer default null,
  p_season_type text default 'reg'
) returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(to_jsonb(m) order by m.week, m.kickoff nulls last, m.home_team), '[]'::jsonb)
  from fsnv2.nfl_matchups m
  where m.season = p_season
    and m.season_type = coalesce(p_season_type, 'reg')
    and (p_week is null or m.week = p_week);
$$;

create or replace function public.fsnv2_nfl_teams()
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(to_jsonb(t) order by t.abbr), '[]'::jsonb) from fsnv2.nfl_teams t;
$$;

-- Freshness dashboard: row counts, newest synced_at per table, and the most
-- recent sync attempts. This is what `npm run test:sync-data` reads back.
create or replace function public.fsnv2_sync_status(p_limit integer default 10)
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select jsonb_build_object(
    'tables', jsonb_build_object(
      'players', jsonb_build_object(
        'rows',      (select count(*) from fsnv2.players where provider is not null),
        'synced_at', (select max(synced_at) from fsnv2.players)),
      'nfl_teams', jsonb_build_object(
        'rows',      (select count(*) from fsnv2.nfl_teams),
        'synced_at', (select max(synced_at) from fsnv2.nfl_teams)),
      'projections', jsonb_build_object(
        'rows',      (select count(*) from fsnv2.projections),
        'synced_at', (select max(synced_at) from fsnv2.projections)),
      'weekly_stats', jsonb_build_object(
        'rows',      (select count(*) from fsnv2.weekly_stats),
        'synced_at', (select max(synced_at) from fsnv2.weekly_stats)),
      'nfl_matchups', jsonb_build_object(
        'rows',      (select count(*) from fsnv2.nfl_matchups),
        'synced_at', (select max(synced_at) from fsnv2.nfl_matchups))
    ),
    'runs', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.started_at desc)
      from (select * from fsnv2.sync_runs order by started_at desc
             limit greatest(coalesce(p_limit, 10), 1)) r
    ), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------------ grants --
-- Writes: the sync service only (secret key / service_role). Reads: the app.
grant usage on schema fsnv2 to service_role;

grant execute on function
  public.fsnv2_sync_nfl_teams(text, jsonb),
  public.fsnv2_sync_players(text, jsonb),
  public.fsnv2_sync_projections(text, jsonb),
  public.fsnv2_sync_weekly_stats(text, jsonb),
  public.fsnv2_sync_schedules(text, jsonb),
  public.fsnv2_log_sync_run(text, text, text, integer, integer, integer, integer, integer, integer, text, jsonb)
to service_role;

revoke execute on function
  public.fsnv2_sync_nfl_teams(text, jsonb),
  public.fsnv2_sync_players(text, jsonb),
  public.fsnv2_sync_projections(text, jsonb),
  public.fsnv2_sync_weekly_stats(text, jsonb),
  public.fsnv2_sync_schedules(text, jsonb),
  public.fsnv2_log_sync_run(text, text, text, integer, integer, integer, integer, integer, integer, text, jsonb)
from anon, authenticated, public;

grant execute on function
  public.fsnv2_projections(integer, integer, text, text, integer),
  public.fsnv2_weekly_stats(integer, integer, text, integer),
  public.fsnv2_nfl_schedule(integer, integer, text),
  public.fsnv2_nfl_teams(),
  public.fsnv2_sync_status(integer)
to anon, authenticated, service_role;
