-- Fix for fsnv2_apply_player_audit's reporting (migration 0006).
--
-- The counters were computed in the UPDATE's RETURNING clause, which yields the
-- NEW row: by the time `p.espn_id is null` was evaluated the id had already been
-- assigned, so every flag read false and the function reported
-- `updated: 0, teams: 0, headshots: 0, ids: 0` while writing the rows correctly.
--
-- The diff now comes from a CTE that joins the payload against fsnv2.players in
-- the same statement snapshot — i.e. the rows as they were before the UPDATE —
-- which is the same shape fsnv2_preview_player_audit already used. The write is
-- unchanged; only the report it returns is now true.
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

revoke all on function public.fsnv2_apply_player_audit(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.fsnv2_apply_player_audit(jsonb, boolean) to service_role;
