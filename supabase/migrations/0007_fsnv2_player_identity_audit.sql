-- =============================================================================
-- FSN v2 — Player identity, headshots, and an external ground truth
-- Apply to the Supabase project `FSN` as migration `fsnv2_player_identity_audit`.
--
-- Migration 0006 fixed the *internal* disagreement: the synthetic pool now takes
-- its team from the synced provider pool, one spelling per franchise, and the
-- browser can no longer push a former club back over a synced one. That closes
-- the loop between our two pools.
--
-- It cannot close the loop with the league. When both pools agree and both are
-- wrong — a player who moved and whom the vendor has not re-rostered, or one the
-- roster feed never carried — there is nothing inside the database to compare
-- against. `fsnv2.players` also had no portrait to render and no cross-feed id to
-- reconcile on, so every match had to go through a name.
--
-- This migration adds the outside reference and the columns it needs:
--
--   fsnv2.canonical_team(text)          the strict half of fsnv2_team_abbr: NULL —
--                                       never a guess — for a numeric team id or
--                                       an unknown code. A number is a provider's
--                                       internal team id, and storing it as a
--                                       franchise is what produced rows like
--                                       "21" and the `DST-10` of migration 0005.
--   players.gsis_id/espn_id/            the cross-feed identity that lets a row be
--     sleeper_id/rotowire_id            matched without trusting its name
--   players.headshot_url                the portrait the UI had nowhere to read
--   players.team_source/audited_at      who last set `team`, so a reconciled
--                                       assignment outranks a client push even
--                                       when the provider pool has never heard of
--                                       the player
--   fsnv2_players_audit_snapshot()      what scripts/audit-players.ts reads
--   fsnv2_preview_player_audit(jsonb)   the read-only twin — what --dry-run reports
--   fsnv2_apply_player_audit(jsonb,...) what it writes, per column and counted
--   fsnv2_player_audit_status()         a standing view of what is still missing
--
-- 0006's `fsnv2_team_abbr`, `fsnv2_player_key` and `fsnv2_refresh_player_teams`
-- all stay exactly as they are and keep doing their job; `fsnv2_team_abbr` is
-- re-pointed at the alias table below so the list is maintained in one place
-- rather than three, with its contract ("alias, else the code uppercased")
-- unchanged. The two upsert functions keep every guard 0006 gave them and gain
-- the identity columns, plus the one lookup the ingestion layer was still
-- missing: a verified team propagated between the two rows for the same player
-- by `espn_id`, which works for players 0006's name match cannot reach.
--
-- Re-runnable: every DDL statement is guarded and every function is CREATE OR
-- REPLACE.
-- =============================================================================

-- ------------------------------------------------------- canonical franchise --
-- The 32 abbreviations this system stores, plus every alias the feeds use for
-- them. Kept in lockstep with lib/services/teams.ts, which is the same table for
-- the ingestion layer; a code added in one place belongs in both.
--
-- IMMUTABLE so it can be used in an index or a generated column later. Returns
-- NULL for a numeric input on purpose: a number is a provider's internal team id
-- or an array index, and storing it is what corrupted the column in the first
-- place.
create or replace function fsnv2.canonical_team(p_value text)
returns text
language sql immutable parallel safe as $$
  with cleaned as (
    select upper(regexp_replace(coalesce(p_value, ''), '[^A-Za-z0-9]', '', 'g')) as code
  )
  select case
    when c.code = '' then null
    when c.code ~ '^[0-9]+$' then null                      -- a team id, not a team
    when c.code in ('FA','FREE','NONE','NA','UFA','RFA','RET') then null
    when c.code in ('ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN',
                    'DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA',
                    'MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB',
                    'TEN','WAS') then c.code
    -- aliases: ESPN, nflverse, Tank01/Sleeper, PFR, and the relocations
    when c.code in ('ARZ','CRD','CARDINALS')            then 'ARI'
    when c.code in ('FALCONS')                          then 'ATL'
    when c.code in ('BLT','RAV','RAVENS')               then 'BAL'
    when c.code in ('BILLS')                            then 'BUF'
    when c.code in ('PANTHERS')                         then 'CAR'
    when c.code in ('BEARS')                            then 'CHI'
    when c.code in ('BENGALS')                          then 'CIN'
    when c.code in ('CLV','BROWNS')                     then 'CLE'
    when c.code in ('COWBOYS')                          then 'DAL'
    when c.code in ('BRONCOS')                          then 'DEN'
    when c.code in ('LIONS')                            then 'DET'
    when c.code in ('GNB','GBP','PACKERS')              then 'GB'
    when c.code in ('HST','HTX','TEXANS')               then 'HOU'
    when c.code in ('CLT','COLTS')                      then 'IND'
    when c.code in ('JAC','JAG','JAGUARS')              then 'JAX'
    when c.code in ('KAN','KCC','CHIEFS')               then 'KC'
    when c.code in ('SD','SDG','CHARGERS')              then 'LAC'
    when c.code in ('LA','RAM','STL','RAMS')            then 'LAR'
    when c.code in ('LVR','OAK','RAI','RAIDERS')        then 'LV'
    when c.code in ('DOLPHINS')                         then 'MIA'
    when c.code in ('VIKINGS')                          then 'MIN'
    when c.code in ('NWE','NEP','PATRIOTS')             then 'NE'
    when c.code in ('NOR','NOS','SAINTS')               then 'NO'
    when c.code in ('GIANTS')                           then 'NYG'
    when c.code in ('JETS')                             then 'NYJ'
    when c.code in ('EAGLES')                           then 'PHI'
    when c.code in ('STEELERS')                         then 'PIT'
    when c.code in ('SEAHAWKS')                         then 'SEA'
    when c.code in ('SFO','49ERS','NINERS')             then 'SF'
    when c.code in ('TAM','TBB','BUCCANEERS','BUCS')    then 'TB'
    when c.code in ('OTI','TITANS')                     then 'TEN'
    when c.code in ('WSH','WFT','COMMANDERS','REDSKINS') then 'WAS'
    else null
  end
  from cleaned c;
$$;

comment on function fsnv2.canonical_team(text) is
  'One spelling per NFL franchise. NULL for a numeric team id, a free-agent code, or an unknown abbreviation — callers decide what to do rather than storing a junk code.';

-- 0006's alias function, re-pointed at the table above so the list is maintained
-- in one place. Its contract is unchanged — an alias resolves, anything else is
-- passed through uppercased — which matters because fsnv2_refresh_player_teams()
-- writes its result straight into a NOT NULL column and must never be handed a
-- NULL. Code that needs "is this actually a franchise?" calls
-- fsnv2.canonical_team() and handles the NULL.
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

-- --------------------------------------------- players: identity + headshots --
alter table fsnv2.players add column if not exists gsis_id      text;
alter table fsnv2.players add column if not exists espn_id      text;
alter table fsnv2.players add column if not exists sleeper_id   text;
alter table fsnv2.players add column if not exists rotowire_id  text;
alter table fsnv2.players add column if not exists headshot_url text;
alter table fsnv2.players add column if not exists audited_at   timestamptz;

-- Who last set `team`. 'nflverse' is a reconciled assignment, 'provider' a live
-- roster feed, 'local' the hand-maintained pool in js/playerData.js. The anon
-- seed path below refuses to downgrade the first two to the third.
alter table fsnv2.players add column if not exists team_source  text;

do $$
begin
  alter table fsnv2.players
    add constraint players_team_source_check
    check (team_source is null or team_source in ('nflverse','provider','local'));
exception
  when duplicate_object then null;
end;
$$;

-- Deliberately NOT unique. The hand-maintained pool and a provider's feed each
-- carry their own row for the same human (documented in 0004: the draft board's
-- `p-0007` and `tank01-3917315` are both Kyler Murray), and the audit stamps the
-- same espn_id on both so they can be kept in step. Uniqueness here would reject
-- exactly the rows the audit needs to link.
create index if not exists players_espn_id_idx     on fsnv2.players (espn_id)     where espn_id is not null;
create index if not exists players_sleeper_id_idx  on fsnv2.players (sleeper_id)  where sleeper_id is not null;
create index if not exists players_gsis_id_idx     on fsnv2.players (gsis_id)     where gsis_id is not null;
create index if not exists players_rotowire_id_idx on fsnv2.players (rotowire_id) where rotowire_id is not null;

comment on column fsnv2.players.espn_id is
  'ESPN player id. Tank01 keys players by this same id, so a tank01 external_id is an espn_id.';
comment on column fsnv2.players.headshot_url is
  'Portrait URL: ESPN''s headshot combiner for a player, ESPN''s team logo for a DST row.';

-- 0006's backfill already canonicalised every stored abbreviation through
-- fsnv2_team_abbr. This is the same pass under the stricter function, which
-- additionally catches a numeric code that predates either migration. A value
-- that resolves to no franchise is left alone and surfaced by the audit rather
-- than overwritten, since there is nothing to overwrite it *with*.
update fsnv2.players
   set team = fsnv2.canonical_team(team)
 where fsnv2.canonical_team(team) is not null
   and fsnv2.canonical_team(team) <> team;

-- nfl_teams is unique on (provider, abbr), so only rewrite where the canonical
-- spelling is not already taken by another row for the same provider (the guard
-- 0006 established).
update fsnv2.nfl_teams t
   set abbr = fsnv2.canonical_team(t.abbr), updated_at = now()
 where fsnv2.canonical_team(t.abbr) is not null
   and fsnv2.canonical_team(t.abbr) <> t.abbr
   and not exists (
     select 1 from fsnv2.nfl_teams o
      where o.provider = t.provider
        and o.abbr = fsnv2.canonical_team(t.abbr)
        and o.id <> t.id
   );

-- Existing rows predate the column; label them by where they came from so the
-- guards below have something to reason about.
update fsnv2.players
   set team_source = case when provider is null then 'local' else 'provider' end
 where team_source is null;

-- ------------------------------------------------------------ audit: read --
-- The snapshot scripts/audit-players.ts reconciles against. Returns every row,
-- including the hand-maintained ones, because those are the rows that drift.
create or replace function public.fsnv2_players_audit_snapshot(p_limit integer default null)
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb)
  from (
    select id, name, position, team, provider, external_id, nfl_team_external_id,
           gsis_id, espn_id, sleeper_id, rotowire_id, headshot_url, jersey, status,
           team_source, audited_at
      from fsnv2.players
     order by id
     limit p_limit
  ) p;
$$;

-- --------------------------------------------------------- audit: preview --
-- The read-only twin: the same diff, computed and counted, with no write. This is
-- what `--dry-run` reports and what fsnv2_apply_player_audit delegates to, so the
-- preview and the real run can never disagree about what would change.
create or replace function public.fsnv2_preview_player_audit(p_rows jsonb)
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  with src as (
    select
      (r ->> 'id')                        as id,
      r ? 'team'         as has_team,
      r ? 'headshot_url' as has_headshot,
      r ? 'espn_id'      as has_espn,
      r ? 'sleeper_id'   as has_sleeper,
      r ? 'gsis_id'      as has_gsis,
      r ? 'rotowire_id'  as has_rotowire,
      r ? 'jersey'       as has_jersey,
      fsnv2.canonical_team(r ->> 'team')  as team,
      nullif(r ->> 'headshot_url', '')    as headshot_url,
      nullif(r ->> 'espn_id', '')         as espn_id,
      nullif(r ->> 'sleeper_id', '')      as sleeper_id,
      nullif(r ->> 'gsis_id', '')         as gsis_id,
      nullif(r ->> 'rotowire_id', '')     as rotowire_id,
      nullif(r ->> 'jersey', '')          as jersey
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
    where nullif(r ->> 'id', '') is not null
  ), diffed as (
    select
      (s.has_team and s.team is not null and s.team <> p.team) as team_changed,
      (s.has_headshot and s.headshot_url is not null
        and coalesce(p.headshot_url, '') <> s.headshot_url)    as headshot_changed,
      ((case when s.has_espn     and p.espn_id     is null and s.espn_id     is not null then 1 else 0 end) +
       (case when s.has_sleeper  and p.sleeper_id  is null and s.sleeper_id  is not null then 1 else 0 end) +
       (case when s.has_gsis     and p.gsis_id     is null and s.gsis_id     is not null then 1 else 0 end) +
       (case when s.has_rotowire and p.rotowire_id is null and s.rotowire_id is not null then 1 else 0 end)) as ids_changed,
      (s.has_jersey and p.jersey is null and s.jersey is not null) as jersey_changed
      from src s join fsnv2.players p on p.id = s.id
  )
  select jsonb_build_object(
    'matched',   (select count(*) from diffed),
    'updated',   (select count(*) from diffed where team_changed or headshot_changed or ids_changed > 0 or jersey_changed),
    'missing',   (select count(*) from src) - (select count(*) from diffed),
    'total',     (select count(*) from src),
    'teams',     (select count(*) from diffed where team_changed),
    'headshots', (select count(*) from diffed where headshot_changed),
    'ids',       (select coalesce(sum(ids_changed), 0) from diffed),
    'jerseys',   (select count(*) from diffed where jersey_changed),
    'dry_run',   true);
$$;

-- ----------------------------------------------------------- audit: write --
-- Applies a reconciled plan, one row per player, keyed on `id`. Only the columns
-- present in a row are touched, so a headshot-only pass cannot disturb a team
-- assignment and vice versa.
--
-- `p_dry_run` hands the same payload to fsnv2_preview_player_audit, which
-- computes the identical diff with no write, so `--dry-run` reports exactly what
-- a real run would change and the script has one code path either way.
create or replace function public.fsnv2_apply_player_audit(
  p_rows    jsonb,
  p_dry_run boolean default false
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_total    integer;
  v_bad      integer;
  v_result   jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'fsnv2_apply_player_audit: p_rows must be a jsonb array, got %',
      coalesce(jsonb_typeof(p_rows), 'null') using errcode = 'P0001';
  end if;

  select count(*) into v_total from jsonb_array_elements(p_rows);
  if v_total = 0 then
    return jsonb_build_object('matched', 0, 'updated', 0, 'missing', 0, 'total', 0,
                              'teams', 0, 'headshots', 0, 'ids', 0, 'jerseys', 0,
                              'dry_run', p_dry_run);
  end if;

  -- A team code in the payload has to be a franchise. The script normalizes
  -- already; this is the backstop that keeps a number out of the column whatever
  -- calls the function.
  select count(*) into v_bad
    from jsonb_array_elements(p_rows) r
   where r ? 'team'
     and nullif(r ->> 'team', '') is not null
     and fsnv2.canonical_team(r ->> 'team') is null;
  if v_bad > 0 then
    raise exception 'fsnv2_apply_player_audit: % row(s) carry a team that is not an NFL franchise', v_bad
      using errcode = 'P0001';
  end if;

  if p_dry_run then
    return public.fsnv2_preview_player_audit(p_rows);
  end if;

  -- One statement, two CTEs that read the *same* snapshot: `diffed` compares the
  -- payload against the rows as they are now, `updated` writes them.
  --
  -- `diffed` cannot be folded into the UPDATE's RETURNING clause, which is the
  -- trap this function fell into first: RETURNING yields the NEW row, so
  -- `p.espn_id is null` is false by the time it is evaluated and every counter
  -- reads zero while the write itself lands correctly. Counting from a CTE that
  -- reads the pre-update snapshot is what makes the report true.
  with src as (
    select
      (r ->> 'id')                                     as id,
      r ? 'team'         as has_team,
      r ? 'headshot_url' as has_headshot,
      r ? 'espn_id'      as has_espn,
      r ? 'sleeper_id'   as has_sleeper,
      r ? 'gsis_id'      as has_gsis,
      r ? 'rotowire_id'  as has_rotowire,
      r ? 'jersey'       as has_jersey,
      fsnv2.canonical_team(r ->> 'team')  as team,
      nullif(r ->> 'headshot_url', '')    as headshot_url,
      nullif(r ->> 'espn_id', '')         as espn_id,
      nullif(r ->> 'sleeper_id', '')      as sleeper_id,
      nullif(r ->> 'gsis_id', '')         as gsis_id,
      nullif(r ->> 'rotowire_id', '')     as rotowire_id,
      nullif(r ->> 'jersey', '')          as jersey
    from jsonb_array_elements(p_rows) r
    where nullif(r ->> 'id', '') is not null
  ), diffed as (
    select
      (s.has_team and s.team is not null and s.team <> p.team) as team_changed,
      (s.has_headshot and s.headshot_url is not null
        and coalesce(p.headshot_url, '') <> s.headshot_url)    as headshot_changed,
      ((case when s.has_espn     and p.espn_id     is null and s.espn_id     is not null then 1 else 0 end) +
       (case when s.has_sleeper  and p.sleeper_id  is null and s.sleeper_id  is not null then 1 else 0 end) +
       (case when s.has_gsis     and p.gsis_id     is null and s.gsis_id     is not null then 1 else 0 end) +
       (case when s.has_rotowire and p.rotowire_id is null and s.rotowire_id is not null then 1 else 0 end)) as ids_changed,
      (s.has_jersey and p.jersey is null and s.jersey is not null) as jersey_changed
      from src s join fsnv2.players p on p.id = s.id
  ), updated as (
    update fsnv2.players p
       set team         = case when s.has_team and s.team is not null then s.team else p.team end,
           team_source  = case when s.has_team and s.team is not null and s.team <> p.team
                               then 'nflverse' else p.team_source end,
           headshot_url = case when s.has_headshot then coalesce(s.headshot_url, p.headshot_url) else p.headshot_url end,
           espn_id      = case when s.has_espn     then coalesce(s.espn_id,     p.espn_id)     else p.espn_id end,
           sleeper_id   = case when s.has_sleeper  then coalesce(s.sleeper_id,  p.sleeper_id)  else p.sleeper_id end,
           gsis_id      = case when s.has_gsis     then coalesce(s.gsis_id,     p.gsis_id)     else p.gsis_id end,
           rotowire_id  = case when s.has_rotowire then coalesce(s.rotowire_id, p.rotowire_id) else p.rotowire_id end,
           jersey       = case when s.has_jersey   then coalesce(s.jersey,      p.jersey)      else p.jersey end,
           audited_at   = now(),
           updated_at   = now()
      from src s
     where p.id = s.id
    returning p.id
  )
  select jsonb_build_object(
      'matched',   (select count(*) from updated),
      'updated',   (select count(*) from diffed
                     where team_changed or headshot_changed or ids_changed > 0 or jersey_changed),
      'missing',   v_total - (select count(*) from updated),
      'total',     v_total,
      'teams',     (select count(*) from diffed where team_changed),
      'headshots', (select count(*) from diffed where headshot_changed),
      'ids',       (select coalesce(sum(ids_changed), 0) from diffed),
      'jerseys',   (select count(*) from diffed where jersey_changed),
      'dry_run',   false)
    into v_result;

  return v_result;
end;
$$;

-- --------------------------------------------- hardened: the anon seed path --
-- js/persistence.js pushes the local projection pool through this function on
-- every draft-board load, which used to make a hand-maintained file the highest
-- authority in the system.
--
-- 0006 fixed that for any player the provider pool knows: `team` is taken from
-- the freshest synced row rather than from the payload. Kept verbatim here, with
-- two additions for the players that pool does *not* know:
--
--   * a team the audit reconciled (team_source = 'nflverse') outranks the
--     client, exactly as a synced one does — otherwise the one class of player
--     only the external reference can fix would drift straight back;
--   * a code that is not a franchise never lands, whatever the client sent.
--
-- Everything else it writes — ADP, VOR, projections, tiers — still belongs to the
-- draft engine and is unchanged.
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
          -- The synced pool still wins (0006). Beyond that: an audited team is
          -- kept, and a client code that is not a franchise never replaces one
          -- that is.
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

-- ------------------------------------------ hardened: the provider sync path --
-- 0006's contract, kept whole — canonical abbreviations on the way in, and
-- fsnv2_refresh_player_teams() at the end so the synthetic pool can never be
-- more than one sync cycle stale — plus:
--
--   * the provider's identity columns are carried through instead of dropped,
--     which is what keeps the audit's espn_id/sleeper_id fresh between runs;
--   * a batch that cannot resolve a player's team no longer overwrites a stored
--     one with 'FA'. A roster feed only lists rostered players, so an
--     unresolvable code means "the payload did not say", not "free agent" — and
--     0006's rule that the roster is the affiliation still holds for every row
--     where the payload *did* say;
--   * a verified team is propagated to the synthetic row for the same player by
--     `espn_id`. fsnv2_refresh_player_teams() matches on name + position, which
--     misses exactly the rows whose names disagree ('Deebo Samuel' vs 'Deebo
--     Samuel Sr.'); an id match does not care what either side calls him.
--   * `unmapped_teams` is returned, so a mapper regression shows up in the sync
--     log instead of quietly filing a roster under 'FA'.
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
      -- The roster the sync read this player from is his affiliation (0006), so
      -- team and nfl_team_external_id are overwritten rather than coalesced —
      -- unless the payload named no franchise at all.
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
          -- Identity and portrait are filled, never blanked by a payload that
          -- happens not to carry them.
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

  -- The id-keyed half of the refresh: the two rows for one player kept in step
  -- by espn_id, for the players a name match cannot reach.
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

  -- And 0006's name-keyed half, unchanged.
  v_refresh := public.fsnv2_refresh_player_teams();

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated,
    'skipped', v_total - v_inserted - v_updated, 'total', v_total,
    'unmapped_teams', v_unmapped, 'linked_by_espn_id', v_linked,
    'refreshed', v_refresh);
end;
$$;

-- ------------------------------------------------------------------ reads --
-- fsnv2_players (0002) already returns `select *`, so headshot_url and the
-- identity columns reach the UI with no change to the read RPC.

-- A standing audit view: what is still missing, per franchise. Cheap enough to
-- poll from a dashboard and the fastest way to see a regression reappear.
create or replace function public.fsnv2_player_audit_status()
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select jsonb_build_object(
    'players', (select count(*) from fsnv2.players),
    'missing_headshot', (select count(*) from fsnv2.players where headshot_url is null),
    'missing_espn_id', (select count(*) from fsnv2.players where espn_id is null),
    'non_canonical_team', (select count(*) from fsnv2.players
                            where fsnv2.canonical_team(team) is distinct from team),
    'free_agents', (select count(*) from fsnv2.players where team = 'FA'),
    'audited', (select count(*) from fsnv2.players where audited_at is not null),
    'last_audit', (select max(audited_at) from fsnv2.players),
    'by_team_source', (select coalesce(jsonb_object_agg(coalesce(team_source,'unset'), n), '{}'::jsonb)
                         from (select team_source, count(*) as n from fsnv2.players
                                group by team_source) s),
    'teams', (select coalesce(jsonb_object_agg(team, n), '{}'::jsonb)
                from (select team, count(*) as n from fsnv2.players group by team) t));
$$;

-- ------------------------------------------------------------------ grants --
-- Writes stay service_role: the audit runs server-side with the secret key.
revoke all on function public.fsnv2_players_audit_snapshot(integer) from public, anon, authenticated;
revoke all on function public.fsnv2_apply_player_audit(jsonb, boolean) from public, anon, authenticated;
revoke all on function public.fsnv2_preview_player_audit(jsonb) from public, anon, authenticated;

grant execute on function
  public.fsnv2_players_audit_snapshot(integer),
  public.fsnv2_apply_player_audit(jsonb, boolean),
  public.fsnv2_preview_player_audit(jsonb),
  public.fsnv2_sync_players(text, jsonb)
to service_role;

-- Reads stay open, same as the rest of the Phase 1/2 surface.
grant execute on function
  public.fsnv2_players(integer),
  public.fsnv2_upsert_players(jsonb),
  public.fsnv2_player_audit_status()
to anon, authenticated, service_role;
