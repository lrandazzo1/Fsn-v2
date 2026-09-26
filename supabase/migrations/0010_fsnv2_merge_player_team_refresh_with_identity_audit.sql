-- Reconciles the two overlapping migrations that landed for the same defect.
--
-- `fsnv2_player_team_refresh` gave both upsert paths a guard the identity-audit
-- migration then overwrote: fsnv2_upsert_players took `team` from the synced
-- provider pool, and fsnv2_sync_players called fsnv2_refresh_player_teams() once
-- the batch had landed. Replacing those function bodies dropped both. This puts
-- them back and keeps the identity columns, so the two sets of guards compose
-- instead of taking turns:
--
--   * `team` still comes from the synced pool when that pool knows the player;
--   * an audited team (team_source = 'nflverse') now also outranks a client push,
--     which covers the players the provider pool has never heard of;
--   * a code that is not a franchise never lands;
--   * the identity columns and headshot_url are filled, never blanked;
--   * refresh runs by name+position (as before) *and* by espn_id, which reaches
--     the rows whose names disagree across feeds.
--
-- fsnv2_team_abbr keeps its exact contract — alias, else the code uppercased —
-- but now reads its alias table from fsnv2.canonical_team() so the list is
-- maintained in one place. fsnv2_refresh_player_teams() writes the result into a
-- NOT NULL column, which is why that function must never return NULL and why the
-- strict variant is a separate function rather than a change to this one.
create or replace function public.fsnv2_team_abbr(p_abbr text)
returns text
language sql immutable as $$
  select coalesce(
    fsnv2.canonical_team(p_abbr),
    upper(nullif(btrim(coalesce(p_abbr, '')), ''))
  );
$$;

comment on function public.fsnv2_team_abbr(text) is
  'One canonical abbreviation per franchise (WSH -> WAS, JAC -> JAX, OAK -> LV …), '
  'falling through to the uppercased input. Aliases come from fsnv2.canonical_team(), '
  'which mirrors CANONICAL_TEAMS/TEAM_ALIASES in lib/services/teams.ts.';

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
      fsnv2.canonical_team(p ->> 'team') as team,
      coalesce((p ->> 'adp')::numeric, 999) as adp,
      coalesce(p -> 'stats', '{}'::jsonb)   as stats
    from jsonb_array_elements(p_players) as p
  ), current_teams as (
    select distinct on (public.fsnv2_player_key(name), position)
           public.fsnv2_player_key(name) as match_key,
           position,
           fsnv2.canonical_team(team)    as team,
           nfl_team_external_id
      from fsnv2.players
     where provider is not null
       and coalesce(team, '') not in ('', 'FA')
     order by public.fsnv2_player_key(name), position, synced_at desc nulls last
  ), resolved as (
    select r.id, r.name, r.position,
           coalesce(c.team, r.team) as team,
           c.nfl_team_external_id,
           c.team is not null       as from_provider,
           r.adp, r.stats
      from rows r
      left join current_teams c
        on c.match_key = public.fsnv2_player_key(r.name)
       and c.position = r.position
  ), upserted as (
    insert into fsnv2.players
      (id, name, position, team, nfl_team_external_id, adp, stats, team_source)
    select id, name, position, coalesce(team, 'FA'), nfl_team_external_id, adp, stats,
           case when from_provider then 'provider' else 'local' end
      from resolved
    on conflict (id) do update
      -- ON CONFLICT can only see `excluded` and the target row, so "did this team
      -- come from the synced pool?" rides in as excluded.team_source.
      set name = excluded.name,
          position = excluded.position,
          team = case
                   when excluded.team_source = 'provider' then excluded.team
                   when fsnv2.players.team_source = 'nflverse' then fsnv2.players.team
                   when excluded.team = 'FA' then fsnv2.players.team
                   else excluded.team
                 end,
          team_source = case
                          when excluded.team_source = 'provider' then 'provider'
                          when fsnv2.players.team_source = 'nflverse' then 'nflverse'
                          when excluded.team = 'FA' then fsnv2.players.team_source
                          else 'local'
                        end,
          nfl_team_external_id =
            coalesce(excluded.nfl_team_external_id, fsnv2.players.nfl_team_external_id),
          adp = excluded.adp,
          stats = excluded.stats,
          updated_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$$;

create or replace function public.fsnv2_sync_players(
  p_provider text,
  p_players  jsonb
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_bad       integer;
  v_inserted  integer := 0;
  v_updated   integer := 0;
  v_total     integer;
  v_unmapped  integer := 0;
  v_linked    integer := 0;
  v_refresh   jsonb;
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

  select count(*) into v_unmapped
    from jsonb_array_elements(p_players) p
   where fsnv2.canonical_team(p ->> 'team') is null;

  with src as (
    select
      coalesce(nullif(p ->> 'id', ''), p_provider || '-' || (p ->> 'external_id')) as id,
      (p ->> 'external_id')                as external_id,
      (p ->> 'name')                       as name,
      upper(p ->> 'position')              as position,
      coalesce(fsnv2.canonical_team(p ->> 'team'), 'FA') as team,
      nullif(p ->> 'nfl_team_external_id', '') as nfl_team_external_id,
      coalesce(nullif(p ->> 'adp', '')::numeric, 999) as adp,
      coalesce(p -> 'stats', '{}'::jsonb)  as stats,
      nullif(p ->> 'jersey', '')           as jersey,
      nullif(p ->> 'status', '')           as status,
      coalesce(p -> 'injury', '{}'::jsonb) as injury,
      nullif(p ->> 'bye_week', '')::integer as bye_week,
      nullif(p ->> 'age', '')::numeric     as age,
      nullif(p ->> 'experience', '')       as experience,
      nullif(p ->> 'college', '')          as college,
      nullif(p ->> 'espn_id', '')          as espn_id,
      nullif(p ->> 'sleeper_id', '')       as sleeper_id,
      nullif(p ->> 'gsis_id', '')          as gsis_id,
      nullif(p ->> 'rotowire_id', '')      as rotowire_id,
      nullif(p ->> 'headshot_url', '')     as headshot_url
    from jsonb_array_elements(p_players) p
  ), eligible as (
    select * from src where position in ('QB','RB','WR','TE','K','DST')
  ), upserted as (
    insert into fsnv2.players
      (id, name, position, team, adp, stats, provider, external_id, nfl_team_external_id,
       jersey, status, injury, bye_week, age, experience, college,
       espn_id, sleeper_id, gsis_id, rotowire_id, headshot_url, team_source, synced_at)
    select id, name, position, team, adp, stats, p_provider, external_id,
           nfl_team_external_id, jersey, status, injury, bye_week, age, experience, college,
           espn_id, sleeper_id, gsis_id, rotowire_id, headshot_url, 'provider', now()
      from eligible
    on conflict (provider, external_id) do update
      set name = excluded.name,
          position = excluded.position,
          team = case when excluded.team = 'FA' then fsnv2.players.team else excluded.team end,
          team_source = case when excluded.team = 'FA' then fsnv2.players.team_source else 'provider' end,
          adp = case when excluded.adp = 999 then fsnv2.players.adp else excluded.adp end,
          stats = fsnv2.players.stats || excluded.stats,
          nfl_team_external_id = case
                                   when excluded.team = 'FA' then fsnv2.players.nfl_team_external_id
                                   else excluded.nfl_team_external_id
                                 end,
          jersey = excluded.jersey, status = excluded.status, injury = excluded.injury,
          bye_week = excluded.bye_week, age = excluded.age,
          experience = excluded.experience, college = excluded.college,
          espn_id = coalesce(excluded.espn_id, fsnv2.players.espn_id),
          sleeper_id = coalesce(excluded.sleeper_id, fsnv2.players.sleeper_id),
          gsis_id = coalesce(excluded.gsis_id, fsnv2.players.gsis_id),
          rotowire_id = coalesce(excluded.rotowire_id, fsnv2.players.rotowire_id),
          headshot_url = coalesce(excluded.headshot_url, fsnv2.players.headshot_url),
          synced_at = now(), updated_at = now()
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted)
    into v_inserted, v_updated
    from upserted;

  with linked as (
    update fsnv2.players local_row
       set team = provider_row.team,
           team_source = 'provider',
           nfl_team_external_id =
             coalesce(provider_row.nfl_team_external_id, local_row.nfl_team_external_id),
           headshot_url = coalesce(local_row.headshot_url, provider_row.headshot_url),
           updated_at = now()
      from fsnv2.players provider_row
     where provider_row.provider = p_provider
       and provider_row.espn_id is not null
       and local_row.provider is null
       and local_row.espn_id = provider_row.espn_id
       and local_row.position = provider_row.position
       and provider_row.team <> 'FA'
       and local_row.team is distinct from provider_row.team
    returning 1
  )
  select count(*) into v_linked from linked;

  v_refresh := public.fsnv2_refresh_player_teams();

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated,
    'skipped', v_total - v_inserted - v_updated, 'total', v_total,
    'unmapped_teams', v_unmapped, 'linked_by_espn_id', v_linked,
    'refreshed', v_refresh);
end;
$$;

revoke execute on function public.fsnv2_sync_players(text, jsonb) from anon, authenticated, public;
grant execute on function public.fsnv2_sync_players(text, jsonb) to service_role;
grant execute on function public.fsnv2_upsert_players(jsonb) to anon, authenticated, service_role;
grant execute on function public.fsnv2_team_abbr(text) to anon, authenticated, service_role;
