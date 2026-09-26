-- Current roster membership is authoritative. Run reconciliation only after
-- every player upsert in a complete 32-team snapshot has succeeded.
create or replace function fsnv2.normalize_player_team()
returns trigger language plpgsql as $$
begin
  new.team := coalesce(nullif(upper(btrim(new.team)), ''), 'FA');
  if new.team = 'FA' then
    new.nfl_team_external_id := null;
    new.bye_week := null;
    if new.provider is not null then
      new.status := 'Free Agent';
    end if;
  end if;
  return new;
end;
$$;

create trigger normalize_player_team_before_write
before insert or update on fsnv2.players
for each row execute function fsnv2.normalize_player_team();

create or replace function public.fsnv2_reconcile_player_roster(
  p_provider text,
  p_active_ids jsonb
) returns integer
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_updated integer;
begin
  if p_provider is null or p_provider = '' then
    raise exception 'fsnv2_reconcile_player_roster: provider is required';
  end if;
  if p_active_ids is null or jsonb_typeof(p_active_ids) <> 'array'
     or jsonb_array_length(p_active_ids) = 0 then
    raise exception 'fsnv2_reconcile_player_roster: active ids must be a nonempty array';
  end if;

  update fsnv2.players p
     set team = 'FA', nfl_team_external_id = null, bye_week = null,
         jersey = null, status = 'Free Agent', updated_at = now(), synced_at = now()
   where p.provider = p_provider
     and p.team <> 'FA'
     and not exists (
       select 1 from jsonb_array_elements_text(p_active_ids) id
        where id = p.external_id
     );
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

-- Correct the bundled demo player's previously persisted row and the matching
-- provider row. The generic reconciliation handles all other roster departures.
update fsnv2.players
   set team = 'FA', nfl_team_external_id = null, bye_week = null,
       jersey = null, status = 'Free Agent', updated_at = now()
 where name = 'Tyreek Hill' and team = 'MIA';

revoke execute on function public.fsnv2_reconcile_player_roster(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.fsnv2_reconcile_player_roster(text, jsonb)
  to service_role;
