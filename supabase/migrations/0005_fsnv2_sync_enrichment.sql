-- =============================================================================
-- FSN v2 — Filling in what the provider leaves out
-- Apply to the Supabase project `FSN` as migration `fsnv2_sync_enrichment`.
--
-- The first live syncs showed two columns arriving null, because Tank01 does not
-- send them (the recorded fixtures happened to include both, which is why this
-- only surfaced against the real API):
--
--   projections.opponent   getNFLProjections carries no opponent
--   weekly_stats.position  getNFLBoxScore entries carry no position
--
-- Both are already known to the database: the week's games are in
-- fsnv2.nfl_matchups and every synced player's position is in fsnv2.players. So
-- the two upserts derive them on the way in rather than the service spending
-- extra provider calls on data it has already stored — and any future provider
-- gets the same treatment for free.
--
-- Deriving on write also means the sync order matters, which is the order the
-- weekly cron already runs: players and schedules first, then projections and
-- box scores. A row whose game or player has not been synced yet simply stays
-- null, exactly as before; nothing fails.
--
-- The tail of this migration backfills the rows written before it.
-- =============================================================================

-- ------------------------------------------------------------ projections --
-- opponent := the other side of that team's game, that week.
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
  ), enriched as (
    -- Prefer the provider's own schedule rows, then the freshest of any other
    -- provider's: they are all describing the same NFL game.
    select s.*, coalesce(s.opponent, game.opponent) as final_opponent
      from src s
      left join lateral (
        select case when m.home_team = s.team then m.away_team else m.home_team end as opponent
          from fsnv2.nfl_matchups m
         where s.team is not null
           and m.season = s.season
           and m.season_type = s.season_type
           and m.week = s.week
           and (m.home_team = s.team or m.away_team = s.team)
         order by (m.provider = p_provider) desc, m.synced_at desc
         limit 1
      ) game on true
  ), upserted as (
    insert into fsnv2.projections
      (provider, external_player_id, player_id, season, week, season_type, scoring_format,
       name, position, team, opponent, fantasy_points, stats, raw, source, synced_at)
    select p_provider, external_player_id, player_id, season, week, season_type, scoring_format,
           name, position, team, final_opponent, fantasy_points, stats, raw, source, now()
      from enriched
    on conflict (provider, season, season_type, week, scoring_format, external_player_id) do update
      set player_id = coalesce(excluded.player_id, fsnv2.projections.player_id),
          name = excluded.name, position = excluded.position,
          team = excluded.team,
          -- Never trade a known opponent for a null on a re-run.
          opponent = coalesce(excluded.opponent, fsnv2.projections.opponent),
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

-- ----------------------------------------------------------- weekly_stats --
-- position := the synced player's position.
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
  ), enriched as (
    select s.*, coalesce(s.position, player.position) as final_position
      from src s
      left join fsnv2.players player
        on player.provider = p_provider
       and player.external_id = s.external_player_id
  ), upserted as (
    insert into fsnv2.weekly_stats
      (provider, external_player_id, player_id, season, week, season_type, game_external_id,
       name, position, team, opponent, fantasy_points, stats, snap_counts, raw, source, synced_at)
    select p_provider, external_player_id, player_id, season, week, season_type, game_external_id,
           name, final_position, team, opponent, fantasy_points, stats, snap_counts, raw, source, now()
      from enriched
    on conflict (provider, season, season_type, week, external_player_id) do update
      set player_id = coalesce(excluded.player_id, fsnv2.weekly_stats.player_id),
          game_external_id = excluded.game_external_id,
          name = excluded.name,
          -- Never trade a known position for a null on a re-run.
          position = coalesce(excluded.position, fsnv2.weekly_stats.position),
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

-- ----------------------------------------------------------------- backfill --
-- The rows already written by the syncs that ran before this migration.
update fsnv2.projections p
   set opponent = game.opponent
  from (
    select pr.id,
           case when m.home_team = pr.team then m.away_team else m.home_team end as opponent
      from fsnv2.projections pr
      join fsnv2.nfl_matchups m
        on m.season = pr.season
       and m.season_type = pr.season_type
       and m.week = pr.week
       and (m.home_team = pr.team or m.away_team = pr.team)
     where pr.opponent is null and pr.team is not null
  ) game
 where p.id = game.id and p.opponent is null;

update fsnv2.weekly_stats w
   set position = player.position
  from fsnv2.players player
 where player.provider = w.provider
   and player.external_id = w.external_player_id
   and w.position is null
   and player.position is not null;
