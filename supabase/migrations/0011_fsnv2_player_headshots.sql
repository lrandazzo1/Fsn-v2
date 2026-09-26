alter table fsnv2.players add column if not exists gsis_id      text;
alter table fsnv2.players add column if not exists espn_id      text;
alter table fsnv2.players add column if not exists sleeper_id   text;
alter table fsnv2.players add column if not exists rotowire_id  text;
alter table fsnv2.players add column if not exists headshot_url text;
alter table fsnv2.players add column if not exists audited_at   timestamptz;
alter table fsnv2.players add column if not exists team_source  text;

comment on column fsnv2.players.headshot_url is
  'Player headshot (ESPN combiner URL), or the team logo for a D/ST row. Read by public.fsnv2_player_assets().';

create index if not exists players_espn_id_idx on fsnv2.players (espn_id) where espn_id is not null;
create index if not exists players_gsis_id_idx on fsnv2.players (gsis_id) where gsis_id is not null;

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
