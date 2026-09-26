-- The UI reads headshots off fsnv2_players (the live bundle it already fetches),
-- so this narrow read is unused. Dropped rather than left orphaned in the schema.
drop function if exists public.fsnv2_player_assets(integer);
