-- =============================================================================
-- FSN v2 — Player headshots for the UI
-- Apply to the Supabase project `FSN` as migration `fsnv2_player_headshots`.
--
-- The player audit resolved every synced player against the public id sets and
-- wrote the results onto fsnv2.players: gsis / espn / sleeper / rotowire ids, a
-- headshot URL, and which source last decided the team. Those columns were added
-- to the live project ahead of this file; the `add column if not exists` block
-- below is therefore a documented no-op there, and the same shape for anyone
-- provisioning the project from `supabase/migrations/` alone.
--
-- What is genuinely new here is the read the browser calls:
--
--   public.fsnv2_player_assets(limit) -> [{id, name, position, team,
--                                          headshot_url, espn_id}, …]
--
-- fsnv2_players(limit) already carried headshot_url — it returns whole rows —
-- but those rows are ~575 kB of projections, stats and injury JSON for 740
-- players, against ~145 kB for the six columns an avatar needs. The UI reads
-- this one on boot and merges it into the pool (js/playerAssets.js); it falls
-- back to fsnv2_players when this function is absent, so an un-migrated project
-- still shows headshots, just over a fatter payload.
--
-- Read-only and granted to anon/authenticated like the rest of the read surface.
-- =============================================================================

-- ------------------------------------------- players: identity + imagery --
-- Already present on the live project; kept here so the migration set is the
-- schema of record.
alter table fsnv2.players add column if not exists gsis_id      text;
alter table fsnv2.players add column if not exists espn_id      text;
alter table fsnv2.players add column if not exists sleeper_id   text;
alter table fsnv2.players add column if not exists rotowire_id  text;
alter table fsnv2.players add column if not exists headshot_url text;
alter table fsnv2.players add column if not exists audited_at   timestamptz;
alter table fsnv2.players add column if not exists team_source  text;

comment on column fsnv2.players.headshot_url is
  'Player headshot (ESPN combiner URL), or the team logo for a D/ST row. Read by public.fsnv2_player_assets().';

-- Lookups by external id, for the audit and for future providers.
create index if not exists players_espn_id_idx on fsnv2.players (espn_id) where espn_id is not null;
create index if not exists players_gsis_id_idx on fsnv2.players (gsis_id) where gsis_id is not null;

-- ------------------------------------------------------- the UI's read --
-- Ordered by adp so the pool arrives in board order, and the rows the draft
-- board is built from (provider is null, the synthetic p-0001 pool) come first
-- on ties — those are the ids the UI matches on.
create or replace function public.fsnv2_player_assets(p_limit integer default 2000)
returns jsonb
language sql stable security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',           p.id,
    'name',         p.name,
    'position',     p.position,
    'team',         p.team,
    'headshot_url', p.headshot_url,
    'espn_id',      p.espn_id
  ) order by p.adp, p.provider nulls first, p.id), '[]'::jsonb)
  from (
    select id, name, position, team, headshot_url, espn_id, adp, provider
      from fsnv2.players
     order by adp, provider nulls first, id
     limit greatest(coalesce(p_limit, 2000), 1)
  ) p;
$$;

comment on function public.fsnv2_player_assets(integer) is
  'Imagery slice of the player pool for the UI avatars: id, name, position, team, headshot_url, espn_id.';

grant execute on function public.fsnv2_player_assets(integer)
  to anon, authenticated, service_role;
