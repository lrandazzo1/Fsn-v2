-- =============================================================================
-- FSN v2 — Player identity, headshots, and one spelling per franchise
-- Apply to the Supabase project `FSN` as migration `fsnv2_player_identity_audit`.
--
-- Three defects, one root cause: `fsnv2.players.team` was whatever the last
-- writer said it was, and nothing in the schema could tell a franchise code from
-- a number.
--
--   1. A provider's numeric team id could land in `team`. Tank01 keys its
--      roster payload by `teamID`, so a mapper that read the key instead of
--      `teamAbv` stored "21" as a franchise (the same class of bug migration
--      0005 fixed for DST rows, which were coming through as `DST-10`).
--
--   2. The same franchise arrived under several spellings — ARI/ARZ, WAS/WSH,
--      LAR/LA — which splits one team's roster across two codes, so a
--      by-team read silently returns half a roster.
--
--   3. `public.fsnv2_upsert_players` is granted to anon: every browser session
--      pushes js/playerData.js into the table and overwrites `team` from a
--      hand-maintained file. A team assignment corrected on Monday was back to
--      the file's value the next time anyone opened the draft board. That is
--      how a player who had moved kept reappearing on his old team, and it is
--      why this migration hardens that function rather than only backfilling
--      data.
--
-- What this migration adds:
--
--   fsnv2.canonical_team(text)          one spelling per franchise, and NULL —
--                                       never a guess — for a number or an
--                                       unknown code
--   players.gsis_id/espn_id/            the cross-feed identity the reconcile
--     sleeper_id/rotowire_id            step matches on
--   players.headshot_url                the portrait the UI has had nowhere to
--                                       read from
--   players.team_source/audited_at      who last set `team`, so a verified
--                                       assignment outranks a client push
--   fsnv2_players_audit_snapshot()      what scripts/audit-players.ts reads
--   fsnv2_apply_player_audit(jsonb)     what it writes, per-column and counted
--
-- and it teaches both existing write paths — the anon seed and the provider
-- sync — to normalize what they are given and to look a player up by id before
-- overwriting his team.
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

-- One-time normalization of what is already stored. A code that resolves to no
-- franchise is left alone and surfaced by the audit rather than overwritten.
update fsnv2.players
   set team = fsnv2.canonical_team(team)
 where fsnv2.canonical_team(team) is not null
   and fsnv2.canonical_team(team) <> team;

update fsnv2.nfl_teams
   set abbr = fsnv2.canonical_team(abbr)
 where fsnv2.canonical_team(abbr) is not null
   and fsnv2.canonical_team(abbr) <> abbr;

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
-- every draft-board load. It used to write `team` verbatim, which made a
-- hand-maintained file the highest authority in the system: a corrected team
-- assignment lasted until the next page view.
--
-- Now: the code is canonicalized, a code that is not a franchise never lands,
-- and a row whose team came from the reference data or a live roster feed keeps
-- it. Projections, ADP and the VOR fields still come from the client — those are
-- the pool's own numbers and nothing else computes them.
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
  ), upserted as (
    insert into fsnv2.players (id, name, position, team, adp, stats, team_source)
    select id, name, position, coalesce(team, 'FA'), adp, stats, 'local' from rows
    on conflict (id) do update
      set name = excluded.name,
          position = excluded.position,
          -- Keep a verified assignment; accept the client's only when it is a
          -- real franchise and nothing better is on record.
          team = case
                   when fsnv2.players.team_source in ('nflverse','provider') then fsnv2.players.team
                   when excluded.team = 'FA' then fsnv2.players.team
                   else excluded.team
                 end,
          team_source = case
                          when fsnv2.players.team_source in ('nflverse','provider')
                            then fsnv2.players.team_source
                          else 'local'
                        end,
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
-- Same contract as 0004, plus:
--   * every team code goes through canonical_team, so 'ARZ'/'WSH'/'LA' and a
--     numeric teamID can no longer reach the column;
--   * a batch that cannot resolve a player's team no longer overwrites a stored
--     one with 'FA' — a roster feed only lists rostered players, so an
--     unresolvable code means "the payload did not say", not "free agent";
--   * the provider's identity columns are carried through instead of being
--     dropped, which is what keeps the audit's espn_id/sleeper_id fresh;
--   * a verified team is propagated to the hand-maintained row for the same
--     player, matched by espn_id — the ID lookup that was missing. Without it
--     the two rows for one man drift apart and the draft board reads the stale
--     one.
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

  -- Rows whose team the payload did not state in a form we recognise. Counted
  -- and returned so a mapper regression is visible in the sync log instead of
  -- quietly filing a roster under 'FA'.
  select count(*) into v_unmapped
    from jsonb_array_elements(p_players) p
   where fsnv2.canonical_team(p ->> 'team') is null;

  with src as (
    select
      coalesce(nullif(p ->> 'id', ''), p_provider || '-' || (p ->> 'external_id')) as id,
      (p ->> 'external_id')                as external_id,
      (p ->> 'name')                       as name,
      upper(p ->> 'position')              as position,
      fsnv2.canonical_team(p ->> 'team')   as team,
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
    select id, name, position, coalesce(team, 'FA'), adp, stats, p_provider, external_id,
           nfl_team_external_id, jersey, status, injury, bye_week, age, experience, college,
           espn_id, sleeper_id, gsis_id, rotowire_id, headshot_url, 'provider', now()
      from eligible
    on conflict (provider, external_id) do update
      set name = excluded.name,
          position = excluded.position,
          -- An unresolvable code never replaces a stored franchise.
          team = case when excluded.team = 'FA' then fsnv2.players.team else excluded.team end,
          team_source = case when excluded.team = 'FA' then fsnv2.players.team_source else 'provider' end,
          adp = case when excluded.adp = 999 then fsnv2.players.adp else excluded.adp end,
          stats = fsnv2.players.stats || excluded.stats,
          nfl_team_external_id = excluded.nfl_team_external_id,
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

  -- Keep the hand-maintained row for the same player in step, by id. This is the
  -- lookup the ingestion layer was missing: without it the provider row moves and
  -- the `p-XXXX` row the draft board reads does not.
  with linked as (
    update fsnv2.players local_row
       set team = provider_row.team,
           team_source = 'provider',
           headshot_url = coalesce(local_row.headshot_url, provider_row.headshot_url),
           updated_at = now()
      from fsnv2.players provider_row
     where provider_row.provider = p_provider
       and provider_row.espn_id is not null
       and local_row.provider is null
       and local_row.espn_id = provider_row.espn_id
       and local_row.position = provider_row.position
       and provider_row.team <> 'FA'
       and local_row.team <> provider_row.team
    returning 1
  )
  select count(*) into v_linked from linked;

  return jsonb_build_object(
    'inserted', v_inserted, 'updated', v_updated,
    'skipped', v_total - v_inserted - v_updated, 'total', v_total,
    'unmapped_teams', v_unmapped, 'linked_local_rows', v_linked);
end;
$$;

-- ------------------------------------------------------------------ reads --
-- Unchanged in shape from 0002 — `select *`, so the new headshot_url and identity
-- columns reach the UI without the read RPC having to be edited again, and no
-- existing consumer loses a field.
create or replace function public.fsnv2_players(p_limit integer default 1000)
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.adp), '[]'::jsonb)
  from (select * from fsnv2.players order by adp limit p_limit) p;
$$;

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
