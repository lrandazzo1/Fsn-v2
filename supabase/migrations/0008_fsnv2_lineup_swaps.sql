-- Persist the demo franchise's slot assignments independently of draft order.
create table if not exists fsnv2.lineups (
  draft_id uuid not null references fsnv2.drafts(id) on delete cascade,
  team_id integer not null,
  roster jsonb not null,
  version integer not null default 0,
  primary key (draft_id, team_id)
);
alter table fsnv2.lineups enable row level security;

-- Builds the same starter-first, then bench assignment as DraftEngine.makePick.
create or replace function public.fsnv2_lineup_state(p_draft_id uuid, p_team_id integer)
returns jsonb language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_draft fsnv2.drafts%rowtype;
  v_saved fsnv2.lineups%rowtype;
  v_roster jsonb := '{"QB":null,"RB1":null,"RB2":null,"WR1":null,"WR2":null,"TE":null,"FLEX":null,"DST":null,"K":null,"BN1":null,"BN2":null,"BN3":null,"BN4":null,"BN5":null,"BN6":null}'::jsonb;
  v_pick record;
  v_key text;
  v_keys text[] := array['QB','RB1','RB2','WR1','WR2','TE','FLEX','DST','K','BN1','BN2','BN3','BN4','BN5','BN6'];
begin
  select * into v_draft from fsnv2.drafts where id = p_draft_id;
  if not found or not exists (
    select 1 from jsonb_array_elements(v_draft.teams) t
    where (t ->> 'slot')::integer = p_team_id and (t ->> 'is_user')::boolean = true
  ) then raise exception 'team is not editable' using errcode = 'P0001'; end if;

  select * into v_saved from fsnv2.lineups where draft_id = p_draft_id and team_id = p_team_id;
  if found then
    if (select count(*) from fsnv2.draft_picks where draft_id = p_draft_id and team_id = p_team_id) =
       (select count(*) from jsonb_each_text(v_saved.roster) r where r.value is not null)
       and not exists (select 1 from fsnv2.draft_picks p where p.draft_id = p_draft_id
         and p.team_id = p_team_id and not exists (
           select 1 from jsonb_each_text(v_saved.roster) r where r.value = p.player_id)) then
      return jsonb_build_object('roster', v_saved.roster, 'version', v_saved.version);
    end if;
    delete from fsnv2.lineups where draft_id = p_draft_id and team_id = p_team_id;
  end if;

  for v_pick in
    select p.player_id, pl.position from fsnv2.draft_picks p
    join fsnv2.players pl on pl.id = p.player_id
    where p.draft_id = p_draft_id and p.team_id = p_team_id order by p.pick_number
  loop
    v_key := null;
    foreach v_key in array v_keys loop
      if v_roster ->> v_key is null and (
        v_key = v_pick.position or
        (v_key in ('RB1','RB2') and v_pick.position = 'RB') or
        (v_key in ('WR1','WR2') and v_pick.position = 'WR') or
        (v_key = 'FLEX' and v_pick.position in ('RB','WR','TE'))
      ) then exit; end if;
    end loop;
    if v_key is null or v_key not in ('QB','RB1','RB2','WR1','WR2','TE','FLEX','DST','K') or
       v_roster ->> v_key is not null then
      v_key := null;
      foreach v_key in array array['BN1','BN2','BN3','BN4','BN5','BN6'] loop
        if v_roster ->> v_key is null then exit; end if;
      end loop;
    end if;
    if v_key is null or v_roster ->> v_key is not null then
      raise exception 'roster is full' using errcode = 'P0001';
    end if;
    v_roster := jsonb_set(v_roster, array[v_key], to_jsonb(v_pick.player_id));
  end loop;
  return jsonb_build_object('roster', v_roster, 'version', 0);
end;
$$;

create or replace function public.fsnv2_swap_lineup(
  p_draft_id uuid, p_team_id integer, p_from text, p_to text,
  p_from_player text, p_to_player text, p_expected_version integer
) returns jsonb language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_state jsonb;
  v_roster jsonb;
  v_from_position text;
  v_to_position text;
  v_keys text[] := array['QB','RB1','RB2','WR1','WR2','TE','FLEX','DST','K','BN1','BN2','BN3','BN4','BN5','BN6'];
  v_count integer;
begin
  -- Serializes swaps and draft writes on this draft; the version rejects stale tabs.
  perform 1 from fsnv2.drafts where id = p_draft_id for update;
  if not found then raise exception 'draft not found' using errcode = 'P0002'; end if;
  v_state := public.fsnv2_lineup_state(p_draft_id, p_team_id);
  v_roster := v_state -> 'roster';
  if p_from is null or p_to is null or p_from = p_to or
     p_from <> all(v_keys) or p_to <> all(v_keys) or
     (v_state ->> 'version')::integer <> p_expected_version or
     v_roster ->> p_from is distinct from p_from_player or
     v_roster ->> p_to is distinct from p_to_player or p_from_player is null then
    raise exception 'lineup changed; reload before swapping' using errcode = 'P0001';
  end if;
  select position into v_from_position from fsnv2.players where id = p_from_player;
  if p_to_player is not null then
    select position into v_to_position from fsnv2.players where id = p_to_player;
  end if;
  if v_from_position is null or
     not (p_to like 'BN%' or p_to = v_from_position or
       (p_to in ('RB1','RB2') and v_from_position = 'RB') or
       (p_to in ('WR1','WR2') and v_from_position = 'WR') or
       (p_to = 'FLEX' and v_from_position in ('RB','WR','TE'))) or
     (p_to_player is not null and not (
       p_from like 'BN%' or p_from = v_to_position or
       (p_from in ('RB1','RB2') and v_to_position = 'RB') or
       (p_from in ('WR1','WR2') and v_to_position = 'WR') or
       (p_from = 'FLEX' and v_to_position in ('RB','WR','TE')))) then
    raise exception 'position is not eligible for this slot' using errcode = 'P0001';
  end if;

  -- Existing mappings must still contain precisely the drafted player set.
  select count(*) into v_count from fsnv2.draft_picks
    where draft_id = p_draft_id and team_id = p_team_id;
  if v_count <> (select count(*) from jsonb_each_text(v_roster) r where r.value is not null) or
     exists (select 1 from fsnv2.draft_picks p where p.draft_id = p_draft_id
       and p.team_id = p_team_id and not exists (
         select 1 from jsonb_each_text(v_roster) r where r.value = p.player_id)) then
    -- The client validates the same invariant on hydration; reject stale maps.
    raise exception 'draft roster changed; reload lineup' using errcode = 'P0001';
  end if;
  v_roster := jsonb_set(jsonb_set(v_roster, array[p_from], coalesce(to_jsonb(p_to_player), 'null'::jsonb)),
    array[p_to], to_jsonb(p_from_player));
  insert into fsnv2.lineups (draft_id, team_id, roster, version)
  values (p_draft_id, p_team_id, v_roster, p_expected_version + 1)
  on conflict (draft_id, team_id) do update
    set roster = excluded.roster, version = excluded.version;
  return jsonb_build_object('roster', v_roster, 'version', p_expected_version + 1);
end;
$$;

grant execute on function public.fsnv2_lineup_state(uuid, integer),
  public.fsnv2_swap_lineup(uuid, integer, text, text, text, text, integer)
to anon, authenticated;

-- PostgREST resolves RPCs from a cached copy of the catalog, so a freshly
-- created function is invisible (PGRST202: "Could not find the function
-- public.fsnv2_swap_lineup(...) in the schema cache") until the cache is
-- refreshed. Ask for the refresh here so applying the migration is enough.
notify pgrst, 'reload schema';
