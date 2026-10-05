-- =============================================================================
-- FSN v2 — The draft pick ledger
--
-- Migration 0014 could trade a draft pick in the sense that it could *record*
-- one: a `DRAFT_PICK` trade item carried a label like '2027-R2', the executed
-- trade reported it in the event payload, and then nothing happened, because
-- there was nowhere for a future pick to live. `fsnv2.draft_picks` is a record
-- of picks *made*. Nothing in this schema said who owns pick 27 of next year's
-- draft, so nothing could change its owner.
--
-- This migration gives a pick an identity and an owner.
--
--   fsnv2.draft_pick_assets    one row per pick slot in a season, with the
--                              team that originally held it and the team that
--                              holds it now
--
-- A pick's identity is `(league, season, round, original_team_id)` and it never
-- changes — that is what makes "Charlie's 2027 second" still mean Charlie's
-- 2027 second after it has been traded twice. Ownership is
-- `current_team_id`, and that is the only column a trade touches.
--
-- -----------------------------------------------------------------------------
-- The ledger is the draft order
-- -----------------------------------------------------------------------------
-- A ledger nothing reads is the same bug one level up, so `fsnv2_record_pick`
-- now asks the ledger who is on the clock, falling back to the snake formula
-- when a league has no ledger for the draft's season. That fallback is what
-- keeps every existing league working unchanged: until `fsnv2_seed_draft_picks`
-- is called, `fsnv2_snake_team` is still the whole truth and nothing in the
-- draft room behaves differently.
--
-- Once a league is seeded, a traded pick genuinely moves: the team that
-- acquired it is the team the database will accept a selection from, and the
-- team that traded it away is skipped. `fsnv2_draft_state` returns the order so
-- the browser derives the same board from the same rows (`setPickOwners()` in
-- js/draftEngine.js).
--
-- Consuming a pick is a stamp, not a delete: `used_by_pick_id` points at the
-- `draft_picks` row that spent it. The FK is `on delete set null`, which means
-- `fsnv2_undo_pick` and `fsnv2_reset_draft` free the slot again by doing
-- exactly what they already do — neither function needed a line changed.
-- =============================================================================

-- ----------------------------------------------------------- a draft's year --
-- A ledger is per season, so a draft has to know which season it is. Existing
-- rows are dated from when they were started; new ones default to the season
-- the clock is in, the same way the sync service decides what "now" means.
alter table fsnv2.drafts add column if not exists season integer;

update fsnv2.drafts
   set season = public.fsnv2_current_nfl_season(coalesce(started_at, created_at))
 where season is null;

alter table fsnv2.drafts
  alter column season set default public.fsnv2_current_nfl_season();

-- ---------------------------------------------------------------- the ledger --
create table if not exists fsnv2.draft_pick_assets (
  id               uuid primary key default gen_random_uuid(),
  league_id        uuid not null references fsnv2.leagues(id) on delete cascade,
  season           integer not null check (season between 2000 and 2100),
  round            integer not null check (round >= 1),
  pick_in_round    integer not null check (pick_in_round >= 1),
  pick_number      integer not null check (pick_number >= 1),
  -- The pick's identity. Never updated: "Charlie's 2027 second" has to keep
  -- meaning that after Charlie has traded it away.
  original_team_id integer not null check (original_team_id >= 1),
  -- The only column a trade writes.
  current_team_id  integer not null check (current_team_id >= 1),
  -- The selection that spent this pick. `on delete set null` is the release:
  -- undoing a pick frees its slot with no extra bookkeeping.
  used_by_pick_id  uuid references fsnv2.draft_picks(id) on delete set null,
  created_at       timestamptz not null default now(),
  constraint draft_pick_assets_slot unique (league_id, season, pick_number),
  constraint draft_pick_assets_identity unique (league_id, season, round, original_team_id)
);

create index if not exists draft_pick_assets_owner_idx
  on fsnv2.draft_pick_assets (league_id, season, current_team_id);
create index if not exists draft_pick_assets_order_idx
  on fsnv2.draft_pick_assets (league_id, season, pick_number);
-- The tradeable set: a pick nobody has spent yet.
create index if not exists draft_pick_assets_open_idx
  on fsnv2.draft_pick_assets (league_id, season) where used_by_pick_id is null;

alter table fsnv2.draft_pick_assets enable row level security;

-- =============================================================================
-- Naming a pick
--
-- Two spellings, because two audiences need one:
--
--   a label    '2027-R2', or '2027-R2-T4' for the pick that was originally
--              team 4's — what a client sends and a person reads
--   the id     the ledger row's uuid — what `trade_items.asset_id` stores, so
--              an item stays unambiguous after the pick changes hands again
--
-- `fsnv2_propose_trade` resolves the first into the second on insert. A label
-- with no team means "the sender's own pick that round", which is the common
-- case and the one worth being terse about.
-- =============================================================================

/* '2027 Round 2', plus the original owner once it is not the current one. */
create or replace function fsnv2.draft_pick_label(
  p_asset fsnv2.draft_pick_assets,
  p_draft_id uuid default null
) returns text language sql stable as $$
  select format('%s Round %s', p_asset.season, p_asset.round)
    || case when p_asset.original_team_id <> p_asset.current_team_id
         then format(' (from %s)', fsnv2.team_label(
                coalesce(p_draft_id, fsnv2.active_draft(p_asset.league_id)),
                p_asset.original_team_id))
         else '' end;
$$;

/* The short form a client can send back: '2027-R2' or '2027-R2-T4'. */
create or replace function fsnv2.draft_pick_slug(p_asset fsnv2.draft_pick_assets)
returns text language sql immutable as $$
  select format('%s-R%s-T%s', p_asset.season, p_asset.round, p_asset.original_team_id);
$$;

/*
 * A uuid or a label to a ledger row id.
 *
 * Accepts the row's own uuid, '2027-R2' (the sender's own pick that round),
 * '2027-R2-T4' / '2027 Round 2 T4' (the pick that was originally team 4's), and
 * raises with the spellings it understands rather than a parse error when it
 * recognises none of them.
 */
create or replace function fsnv2.resolve_draft_pick(
  p_league_id uuid,
  p_sender_team_id integer,
  p_asset_id text
) returns uuid
language plpgsql stable as $$
declare
  v_parts text[];
  v_season integer;
  v_round integer;
  v_team integer;
  v_id uuid;
begin
  if p_asset_id is null or btrim(p_asset_id) = '' then
    raise exception 'a draft-pick item needs an asset id' using errcode = 'P0001';
  end if;

  -- The id itself, which is what a well-behaved client round-trips.
  if p_asset_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select id into v_id from fsnv2.draft_pick_assets
     where id = p_asset_id::uuid and league_id = p_league_id;
    if v_id is null then
      raise exception 'draft pick % is not in this league''s ledger', p_asset_id
        using errcode = 'P0002';
    end if;
    return v_id;
  end if;

  v_parts := regexp_match(
    btrim(p_asset_id),
    '^(\d{4})[\s_-]*R(?:ound)?[\s_-]*(\d{1,2})(?:[\s_-]*T(?:eam)?[\s_-]*(\d{1,2}))?$',
    'i');
  if v_parts is null then
    raise exception
      'cannot read "%" as a draft pick — use the ledger id, or 2027-R2 (your own) or 2027-R2-T4',
      p_asset_id using errcode = 'P0001';
  end if;

  v_season := v_parts[1]::integer;
  v_round  := v_parts[2]::integer;
  v_team   := coalesce(v_parts[3]::integer, p_sender_team_id);

  select id into v_id from fsnv2.draft_pick_assets
   where league_id = p_league_id and season = v_season
     and round = v_round and original_team_id = v_team;
  if v_id is null then
    raise exception
      'no % round-% pick for team % in this league — seed the ledger with fsnv2_seed_draft_picks first',
      v_season, v_round, v_team using errcode = 'P0002';
  end if;
  return v_id;
end;
$$;

-- =============================================================================
-- Seeding
--
-- The grid a season starts from: `rounds x total_teams` slots, each originally
-- owned by whichever team the league's own draft order gives it. Idempotent by
-- design — `on conflict do nothing` on the slot key — so re-running it after a
-- trade adds any missing rounds and leaves every ownership change alone. That
-- matters more than it sounds: "we extended the draft to 16 rounds" and "we
-- lost the ledger" must not be the same operation.
-- =============================================================================
create or replace function public.fsnv2_seed_draft_picks(
  p_league_id  uuid,
  p_season     integer default null,
  p_rounds     integer default null,
  p_draft_type text default null
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_total  integer;
  v_season integer;
  v_rounds integer;
  v_type   text;
  v_draft  uuid := fsnv2.active_draft(p_league_id);
begin
  select total_teams into v_total from fsnv2.leagues where id = p_league_id;
  if not found then
    raise exception 'league % not found', p_league_id using errcode = 'P0002';
  end if;

  -- Season, length and order all default to the league's live draft, so a
  -- bare call seeds the draft the league is actually running.
  v_season := coalesce(p_season, (select season from fsnv2.drafts where id = v_draft),
                       public.fsnv2_current_nfl_season());
  v_rounds := coalesce(p_rounds, (select rounds from fsnv2.drafts where id = v_draft), 15);
  v_type   := coalesce(p_draft_type, (select draft_type from fsnv2.drafts where id = v_draft),
                       'snake');

  if v_rounds < 1 or v_rounds > 30 then
    raise exception 'round count must be between 1 and 30, got %', v_rounds
      using errcode = 'P0001';
  end if;

  insert into fsnv2.draft_pick_assets (
    league_id, season, round, pick_in_round, pick_number,
    original_team_id, current_team_id)
  select p_league_id,
         v_season,
         ((n - 1) / v_total) + 1,
         ((n - 1) % v_total) + 1,
         n,
         public.fsnv2_snake_team(n, v_total, v_type),
         public.fsnv2_snake_team(n, v_total, v_type)
    from generate_series(1, v_total * v_rounds) n
  on conflict (league_id, season, pick_number) do nothing;

  -- Seeding a draft that is already under way: the slots whose selections have
  -- been made are stamped with them. Without this, a league seeded at pick 40
  -- would show its first 39 picks as unspent — and let somebody trade a pick
  -- that has already been used.
  update fsnv2.draft_pick_assets a
     set used_by_pick_id = p.id
    from fsnv2.draft_picks p
    join fsnv2.drafts d on d.id = p.draft_id
   where a.league_id = p_league_id
     and a.season = v_season
     and d.league_id = p_league_id
     and d.season = v_season
     and p.pick_number = a.pick_number
     and a.used_by_pick_id is null;

  return public.fsnv2_draft_pick_ledger(p_league_id, v_season);
end;
$$;

-- =============================================================================
-- Reads
-- =============================================================================

/* The whole ledger for a season, in pick order, optionally for one team. */
create or replace function public.fsnv2_draft_pick_ledger(
  p_league_id uuid,
  p_season    integer default null,
  p_team_id   integer default null
) returns jsonb
language sql stable security definer set search_path = fsnv2, public as $$
  with draft as (select fsnv2.active_draft(p_league_id) as id),
       season as (
         select coalesce(p_season,
           (select d.season from fsnv2.drafts d, draft where d.id = draft.id),
           public.fsnv2_current_nfl_season()) as year
       )
  select coalesce(jsonb_agg(jsonb_build_object(
           'pick_id',          a.id,
           'season',           a.season,
           'round',            a.round,
           'pick_in_round',    a.pick_in_round,
           'pick_number',      a.pick_number,
           'original_team_id', a.original_team_id,
           'current_team_id',  a.current_team_id,
           'traded',           a.original_team_id <> a.current_team_id,
           'used',             a.used_by_pick_id is not null,
           'slug',             fsnv2.draft_pick_slug(a),
           'label',            fsnv2.draft_pick_label(a, draft.id),
           'original_team',    fsnv2.team_label(draft.id, a.original_team_id),
           'current_team',     fsnv2.team_label(draft.id, a.current_team_id)
         ) order by a.pick_number), '[]'::jsonb)
  from fsnv2.draft_pick_assets a, draft, season
  where a.league_id = p_league_id
    and a.season = season.year
    and (p_team_id is null or a.current_team_id = p_team_id);
$$;

/*
 * The draft order as the board needs it: `pick_number -> current_team_id`.
 *
 * Empty when the league has no ledger for that season, which is how every
 * caller tells "nobody has traded a pick" from "the snake formula is still the
 * whole truth here" — the same posture js/gameLock.js takes with a week the
 * sync has not stored.
 */
create or replace function public.fsnv2_draft_order(
  p_league_id uuid,
  p_season    integer default null
) returns jsonb
language sql stable security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_object_agg(a.pick_number::text, a.current_team_id), '{}'::jsonb)
  from fsnv2.draft_pick_assets a
  where a.league_id = p_league_id
    and a.season = coalesce(p_season,
      (select d.season from fsnv2.drafts d
        where d.id = fsnv2.active_draft(p_league_id)),
      public.fsnv2_current_nfl_season());
$$;

/*
 * Who is on the clock for this pick: the ledger when the league has one for
 * this draft's season, the snake formula when it does not.
 */
create or replace function public.fsnv2_draft_pick_owner(
  p_draft_id    uuid,
  p_pick_number integer
) returns integer
language plpgsql stable security definer set search_path = fsnv2, public as $$
declare
  v_draft fsnv2.drafts%rowtype;
  v_total integer;
  v_owner integer;
begin
  select * into v_draft from fsnv2.drafts where id = p_draft_id;
  if not found then
    raise exception 'draft % not found', p_draft_id using errcode = 'P0002';
  end if;

  select current_team_id into v_owner from fsnv2.draft_pick_assets
   where league_id = v_draft.league_id
     and season = v_draft.season
     and pick_number = p_pick_number;
  if v_owner is not null then
    return v_owner;
  end if;

  select total_teams into v_total from fsnv2.leagues where id = v_draft.league_id;
  return public.fsnv2_snake_team(p_pick_number, v_total, v_draft.draft_type);
end;
$$;

-- =============================================================================
-- The draft itself
--
-- `fsnv2_record_pick` is 0002's function with one change: the team it expects
-- comes from `fsnv2_draft_pick_owner` instead of straight from
-- `fsnv2_snake_team`, and the ledger row that was spent is stamped with the
-- selection that spent it. Everything else — the out-of-order check, the draft
-- length check, the clock advance, the return shape — is 0002's, kept verbatim
-- so the two can be diffed.
--
-- With no ledger for the draft's season the owner lookup *is* the snake
-- formula, so a league that has never seeded one cannot tell the difference.
-- =============================================================================
create or replace function public.fsnv2_record_pick(
  p_draft_id    uuid,
  p_pick_number integer,
  p_player_id   text,
  p_team_id     integer default null,
  p_auto        boolean default false,
  p_source      text default 'manual'
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_draft        fsnv2.drafts;
  v_total        integer;
  v_round        integer;
  v_expected     integer;
  v_pick         fsnv2.draft_picks;
  v_total_picks  integer;
  v_snake        integer;
begin
  select d.* into v_draft from fsnv2.drafts d where d.id = p_draft_id for update;
  if not found then
    raise exception 'draft % not found', p_draft_id using errcode = 'P0002';
  end if;
  if v_draft.status = 'complete' then
    raise exception 'draft % is already complete', p_draft_id using errcode = 'P0001';
  end if;

  select l.total_teams into v_total from fsnv2.leagues l where l.id = v_draft.league_id;
  v_total_picks := v_total * v_draft.rounds;

  if p_pick_number <> v_draft.current_pick then
    raise exception 'out of order pick: got %, draft is on pick %', p_pick_number, v_draft.current_pick
      using errcode = 'P0001';
  end if;
  if p_pick_number > v_total_picks then
    raise exception 'pick % exceeds draft length (%)', p_pick_number, v_total_picks using errcode = 'P0001';
  end if;

  v_round    := ((p_pick_number - 1) / v_total) + 1;
  v_expected := public.fsnv2_draft_pick_owner(p_draft_id, p_pick_number);
  v_snake    := public.fsnv2_snake_team(p_pick_number, v_total, v_draft.draft_type);

  if p_team_id is not null and p_team_id <> v_expected then
    -- Two different mistakes, and a client that computed the snake order
    -- itself deserves to be told which one it made: its formula is right and
    -- its *data* is stale, because this pick has been traded.
    if v_expected <> v_snake and p_team_id = v_snake then
      raise exception
        'pick % was traded: it belongs to team %, not team % — reload the draft order',
        p_pick_number, v_expected, p_team_id using errcode = 'P0001';
    end if;
    raise exception 'snake order violation: pick % belongs to team %, got %',
      p_pick_number, v_expected, p_team_id using errcode = 'P0001';
  end if;

  insert into fsnv2.draft_picks (draft_id, pick_number, round, team_id, player_id, auto, source)
  values (p_draft_id, p_pick_number, v_round, v_expected, p_player_id, p_auto, p_source)
  returning * into v_pick;

  -- Spend the ledger slot. A no-op for an unseeded league; released again by
  -- the `on delete set null` when fsnv2_undo_pick or fsnv2_reset_draft deletes
  -- the selection.
  update fsnv2.draft_pick_assets
     set used_by_pick_id = v_pick.id
   where league_id = v_draft.league_id
     and season = v_draft.season
     and pick_number = p_pick_number;

  update fsnv2.drafts
     set current_pick = least(p_pick_number + 1, v_total_picks),
         status       = case when p_pick_number >= v_total_picks then 'complete' else 'in_progress' end,
         completed_at = case when p_pick_number >= v_total_picks then now() else null end
   where id = p_draft_id
   returning * into v_draft;

  return jsonb_build_object('pick', to_jsonb(v_pick), 'draft', to_jsonb(v_draft));
end;
$$;

/*
 * 0002's hydrate, plus the draft order.
 *
 * `pick_order` is `{"27": 4, ...}` — only the picks the ledger knows about, and
 * `{}` for a league that has never been seeded. The browser installs it with
 * `setPickOwners()`, so the board, the "on the clock" header, `nextUp()` and
 * every auto-pick path read the same ownership the database will enforce,
 * from the same round trip that already hydrated the board.
 */
create or replace function public.fsnv2_draft_state(p_draft_id uuid)
returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  select jsonb_build_object(
    'draft',  to_jsonb(d),
    'league', to_jsonb(l),
    'picks',  coalesce((
      select jsonb_agg(to_jsonb(p) order by p.pick_number)
      from fsnv2.draft_picks p where p.draft_id = d.id
    ), '[]'::jsonb),
    'pick_order', public.fsnv2_draft_order(d.league_id, d.season),
    'pick_ledger', public.fsnv2_draft_pick_ledger(d.league_id, d.season)
  )
  from fsnv2.drafts d
  join fsnv2.leagues l on l.id = d.league_id
  where d.id = p_draft_id;
$$;

-- =============================================================================
-- Trading a pick
--
-- The three places 0014 left a `DRAFT_PICK` item unfinished.
-- =============================================================================

/*
 * 0014's validator, with draft picks added: the sender must currently hold the
 * pick, and nobody may have spent it yet. The rest of the body is 0014's.
 *
 * A pick does not count towards a roster limit — it is not a player yet — so
 * the roster-space arithmetic below deliberately ignores `DRAFT_PICK` items.
 */
create or replace function fsnv2.assert_trade_valid(p_trade_id uuid)
returns void language plpgsql as $$
declare
  v_trade    fsnv2.trades;
  v_draft    uuid;
  v_capacity integer;
  v_item     record;
  v_team     integer;
  v_sent     integer;
  v_received integer;
  v_size     integer;
  v_faab     numeric;
  v_owed     numeric;
  v_asset    fsnv2.draft_pick_assets;
begin
  select * into v_trade from fsnv2.trades where id = p_trade_id;
  if not found then
    raise exception 'trade % not found', p_trade_id using errcode = 'P0002';
  end if;
  v_draft    := fsnv2.require_draft(v_trade.league_id);
  v_capacity := fsnv2.roster_capacity(v_trade.league_id);

  if not exists (select 1 from fsnv2.trade_items where trade_id = p_trade_id) then
    raise exception 'a trade has to move at least one asset' using errcode = 'P0001';
  end if;

  for v_item in
    select i.* from fsnv2.trade_items i where i.trade_id = p_trade_id
  loop
    if v_item.sender_team_id not in (v_trade.proposer_team_id, v_trade.recipient_team_id) then
      raise exception 'team % is not part of this trade', v_item.sender_team_id
        using errcode = 'P0001';
    end if;

    if v_item.asset_type = 'PLAYER'
       and fsnv2.player_owner(v_draft, v_item.asset_id) is distinct from v_item.sender_team_id then
      raise exception '% is not on %''s roster',
        coalesce((select name from fsnv2.players where id = v_item.asset_id), v_item.asset_id),
        fsnv2.team_label(v_draft, v_item.sender_team_id)
        using errcode = 'P0001';
    end if;

    if v_item.asset_type = 'DRAFT_PICK' then
      -- `fsnv2_propose_trade` stores the ledger id, so a label here means the
      -- row was written by something else — say so rather than silently
      -- treating an unresolvable pick as tradeable.
      select * into v_asset from fsnv2.draft_pick_assets
       where id = (case when v_item.asset_id ~*
                     '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then v_item.asset_id::uuid end)
         and league_id = v_trade.league_id;
      if not found then
        raise exception 'draft pick "%" is not in this league''s ledger', v_item.asset_id
          using errcode = 'P0002';
      end if;
      if v_asset.current_team_id <> v_item.sender_team_id then
        raise exception '% is not %''s pick to trade',
          fsnv2.draft_pick_label(v_asset, v_draft),
          fsnv2.team_label(v_draft, v_item.sender_team_id)
          using errcode = 'P0001';
      end if;
      if v_asset.used_by_pick_id is not null then
        raise exception '% has already been used',
          fsnv2.draft_pick_label(v_asset, v_draft) using errcode = 'P0001';
      end if;
    end if;
  end loop;

  -- Both sides have to be able to field the roster the trade leaves them with,
  -- and to cover the FAAB they are sending.
  foreach v_team in array array[v_trade.proposer_team_id, v_trade.recipient_team_id] loop
    select count(*) filter (where i.sender_team_id = v_team and i.asset_type = 'PLAYER'),
           count(*) filter (where i.sender_team_id <> v_team and i.asset_type = 'PLAYER'),
           coalesce(sum(i.amount) filter (where i.sender_team_id = v_team
                                            and i.asset_type = 'FAAB'), 0)
      into v_sent, v_received, v_owed
      from fsnv2.trade_items i where i.trade_id = p_trade_id;

    v_size := fsnv2.roster_size(v_draft, v_team);
    if v_size - v_sent + v_received > v_capacity then
      raise exception '% would be left with % players, over this league''s limit of %',
        fsnv2.team_label(v_draft, v_team), v_size - v_sent + v_received, v_capacity
        using errcode = 'P0001';
    end if;

    if v_owed > 0 then
      v_faab := (fsnv2.ensure_waiver_state(v_trade.league_id, v_team)).faab_balance;
      if v_owed > v_faab then
        raise exception '% cannot send $% of FAAB — only $% is left',
          fsnv2.team_label(v_draft, v_team), fsnv2.money(v_owed), fsnv2.money(v_faab)
          using errcode = 'P0001';
      end if;
    end if;
  end loop;
end;
$$;

/*
 * One jsonb object naming a pick, for a trade payload and for an article.
 *
 * Denormalised for the same reason `fsnv2.player_card` is: a Trade Breakdown
 * written next March must still say "Charlie's 2027 second" even though the
 * pick has been used by then and the ledger row now points at a selection.
 */
create or replace function fsnv2.draft_pick_card(
  p_asset_id text,
  p_draft_id uuid default null
) returns jsonb language sql stable as $$
  select case when p_asset_id is null then null else coalesce(
    (select jsonb_build_object(
       'pick_id',          a.id,
       'season',           a.season,
       'round',            a.round,
       'pick_number',      a.pick_number,
       'original_team_id', a.original_team_id,
       'current_team_id',  a.current_team_id,
       'slug',             fsnv2.draft_pick_slug(a),
       'label',            fsnv2.draft_pick_label(a, p_draft_id),
       'original_team',    fsnv2.team_label(
                             coalesce(p_draft_id, fsnv2.active_draft(a.league_id)),
                             a.original_team_id),
       'used',             a.used_by_pick_id is not null)
       from fsnv2.draft_pick_assets a
      where a.id = (case when p_asset_id ~*
                      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    then p_asset_id::uuid end)),
    -- A row written before the ledger existed, or by hand: show the label the
    -- item carries rather than dropping the asset out of the payload.
    jsonb_build_object('label', p_asset_id, 'slug', p_asset_id)) end;
$$;

-- =============================================================================
-- 0014's three trade functions, with the pick half finished.
--
-- Each body below is 0014's, kept verbatim apart from the block named in its
-- comment, so the two migrations can be diffed the way 0013 can be diffed
-- against 0008. The changes are:
--
--   fsnv2.trade_payload     a DRAFT_PICK item renders its pick, not just an id
--   fsnv2_propose_trade     a label is resolved to a ledger id on insert
--   fsnv2_execute_trade     the pick's current_team_id actually moves
-- =============================================================================

create or replace function fsnv2.trade_payload(p_trade_id uuid)
returns jsonb language plpgsql stable as $$
declare v_trade fsnv2.trades; v_draft uuid;
begin
  select * into v_trade from fsnv2.trades where id = p_trade_id;
  if not found then
    raise exception 'trade % not found', p_trade_id using errcode = 'P0002';
  end if;
  v_draft := fsnv2.active_draft(v_trade.league_id);

  return jsonb_build_object(
    'trade_id',          v_trade.id,
    'league_id',         v_trade.league_id,
    'status',            v_trade.status,
    'status_detail',     v_trade.status_detail,
    'expires_at',        v_trade.expires_at,
    'note',              v_trade.note,
    'created_at',        v_trade.created_at,
    'responded_at',      v_trade.responded_at,
    'executed_at',       v_trade.executed_at,
    'effective_week',    v_trade.effective_week,
    'deferred_from_week', v_trade.deferred_from_week,
    'proposer', jsonb_build_object(
      'team_id', v_trade.proposer_team_id,
      'team_name', fsnv2.team_label(v_draft, v_trade.proposer_team_id)),
    'recipient', jsonb_build_object(
      'team_id', v_trade.recipient_team_id,
      'team_name', fsnv2.team_label(v_draft, v_trade.recipient_team_id)),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'item_id',        i.id,
               'sender_team_id', i.sender_team_id,
               'sender_name',    fsnv2.team_label(v_draft, i.sender_team_id),
               'receiver_team_id', case when i.sender_team_id = v_trade.proposer_team_id
                                     then v_trade.recipient_team_id
                                     else v_trade.proposer_team_id end,
               'asset_type',     i.asset_type,
               'asset_id',       i.asset_id,
               'amount',         i.amount,
               'player',         case when i.asset_type = 'PLAYER'
                                   then fsnv2.player_card(i.asset_id) end,
               'draft_pick',     case when i.asset_type = 'DRAFT_PICK'
                                   then fsnv2.draft_pick_card(i.asset_id, v_draft) end)
             order by i.sender_team_id, i.asset_type, i.asset_id)
        from fsnv2.trade_items i where i.trade_id = p_trade_id), '[]'::jsonb)
  );
end;
$$;

create or replace function public.fsnv2_propose_trade(
  p_league_id         uuid,
  p_proposer_team_id  integer,
  p_recipient_team_id integer,
  p_items             jsonb,
  p_expires_at        timestamptz default null,
  p_note              text default null
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_trade   fsnv2.trades;
  v_draft   uuid;
  v_expires timestamptz;
  v_payload jsonb;
begin
  perform fsnv2.require_team(p_league_id, p_proposer_team_id);
  perform fsnv2.require_team(p_league_id, p_recipient_team_id);
  if p_proposer_team_id = p_recipient_team_id then
    raise exception 'a team cannot trade with itself' using errcode = 'P0001';
  end if;
  v_draft := fsnv2.require_draft(p_league_id);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'a trade has to move at least one asset' using errcode = 'P0001';
  end if;

  -- Two days is the league default; an explicit expiry has to be in the future
  -- or the trade would arrive already dead.
  v_expires := coalesce(p_expires_at, now() + interval '48 hours');
  if v_expires <= now() then
    raise exception 'the expiry has to be in the future' using errcode = 'P0001';
  end if;

  insert into fsnv2.trades (
    league_id, proposer_team_id, recipient_team_id, expires_at, note)
  values (p_league_id, p_proposer_team_id, p_recipient_team_id, v_expires, p_note)
  returning * into v_trade;

  insert into fsnv2.trade_items (trade_id, sender_team_id, asset_type, asset_id, amount)
  select v_trade.id,
         coalesce((i ->> 'sender_team_id')::integer, (i ->> 'senderTeamId')::integer),
         upper(coalesce(i ->> 'asset_type', i ->> 'assetType')),
         nullif(coalesce(i ->> 'asset_id', i ->> 'assetId'), ''),
         nullif(i ->> 'amount', '')::numeric
    from jsonb_array_elements(p_items) i;

  -- A draft pick may arrive as a label ('2027-R2', '2027-R2-T4') or as a
  -- ledger id. It is stored as the id, always: a label means "the sender's own
  -- second next year", and that stops being true the moment the pick is traded
  -- on, while the id keeps pointing at the same pick for ever.
  update fsnv2.trade_items i
     set asset_id = fsnv2.resolve_draft_pick(p_league_id, i.sender_team_id, i.asset_id)::text
   where i.trade_id = v_trade.id and i.asset_type = 'DRAFT_PICK';

  -- Both rosters, both budgets, and every asset's owner — checked after the
  -- insert so the table constraints have run first, and inside the same
  -- transaction, so a refusal leaves no trade behind.
  perform fsnv2.assert_trade_valid(v_trade.id);

  v_payload := fsnv2.trade_payload(v_trade.id);
  perform fsnv2.emit_league_event(
    p_league_id, 'TRADE_PROPOSED', v_payload, 'trade', v_trade.id::text,
    now(), null, null, 'trade-proposed:' || v_trade.id::text, 'SKIPPED');

  return v_payload;
end;
$$;

create or replace function public.fsnv2_execute_trade(
  p_trade_id uuid,
  p_now      timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_trade   fsnv2.trades;
  v_draft   uuid;
  v_at      timestamptz := coalesce(p_now, now());
  v_season  integer;
  v_week    integer;
  v_locked  jsonb;
  v_item    record;
  v_to      integer;
  v_payload jsonb;
  v_moves   jsonb := '[]'::jsonb;
  v_detail  text;
  v_asset   fsnv2.draft_pick_assets;
begin
  select * into v_trade from fsnv2.trades where id = p_trade_id for update;
  if not found then
    raise exception 'trade % not found', p_trade_id using errcode = 'P0002';
  end if;

  if v_trade.status = 'EXECUTED' then
    -- Idempotent: a retried request gets the trade, not a second swap.
    return fsnv2.trade_payload(p_trade_id);
  end if;
  if v_trade.status not in ('ACCEPTED', 'PENDING_NEXT_WEEK') then
    raise exception 'only an accepted trade can be executed; this one is %',
      lower(v_trade.status) using errcode = 'P0001';
  end if;

  v_draft  := fsnv2.require_draft(v_trade.league_id);
  v_season := public.fsnv2_current_nfl_season(v_at);
  v_week   := public.fsnv2_current_nfl_week(v_at);

  -- Serialise against the lineup swap and the draft board, which take the same
  -- row (0008, 0013).
  perform 1 from fsnv2.drafts where id = v_draft for update;

  -- --------------------------------------------------------- the lock guard --
  v_locked := public.fsnv2_trade_lock_report(p_trade_id, v_at);
  if jsonb_array_length(v_locked) > 0 then
    v_detail := format('%s %s in a game that has already started; the trade takes effect in week %s.',
      v_locked -> 0 ->> 'name',
      case when jsonb_array_length(v_locked) > 1
        then format('and %s other player(s) are', jsonb_array_length(v_locked) - 1)
        else 'is' end,
      least(18, v_week + 1));

    update fsnv2.trades
       set status             = 'PENDING_NEXT_WEEK',
           deferred_from_week = v_week,
           effective_week     = least(18, v_week + 1),
           status_detail      = v_detail
     where id = p_trade_id
    returning * into v_trade;

    v_payload := fsnv2.trade_payload(p_trade_id)
                 || jsonb_build_object('locked_players', v_locked);

    -- Valid *from next week*: the fact this event records is not true yet, and
    -- the recorded_at the row carries is now. That split is why the log is
    -- bitemporal — a Trade Breakdown written today has to be able to say
    -- "agreed today, effective next week" without back-dating anything.
    perform fsnv2.emit_league_event(
      v_trade.league_id, 'TRADE_DEFERRED', v_payload, 'trade', p_trade_id::text,
      v_at, v_trade.effective_week, v_season,
      format('trade-deferred:%s:%s', p_trade_id, v_week));

    return v_payload;
  end if;

  -- Rosters and budgets can have moved since the handshake.
  perform fsnv2.assert_trade_valid(p_trade_id);

  -- ------------------------------------------------------------- the swap ----
  -- Out of both rosters first...
  for v_item in
    select i.* from fsnv2.trade_items i
     where i.trade_id = p_trade_id and i.asset_type = 'PLAYER'
     order by i.sender_team_id, i.asset_id
  loop
    perform fsnv2.apply_roster_change(
      v_draft, v_item.sender_team_id, null, v_item.asset_id, 'trade');
  end loop;

  -- ...then into the other one.
  for v_item in
    select i.* from fsnv2.trade_items i
     where i.trade_id = p_trade_id and i.asset_type = 'PLAYER'
     order by i.sender_team_id, i.asset_id
  loop
    v_to := case when v_item.sender_team_id = v_trade.proposer_team_id
              then v_trade.recipient_team_id else v_trade.proposer_team_id end;
    v_moves := v_moves || jsonb_build_array(
      fsnv2.apply_roster_change(v_draft, v_to, v_item.asset_id, null, 'trade')
      || jsonb_build_object(
           'from_team_id', v_item.sender_team_id,
           'to_team_id',   v_to,
           'player',       fsnv2.player_card(v_item.asset_id)));
  end loop;

  -- FAAB moves with the players, out of the same balance the waiver wire spends.
  for v_item in
    select i.* from fsnv2.trade_items i
     where i.trade_id = p_trade_id and i.asset_type = 'FAAB'
  loop
    v_to := case when v_item.sender_team_id = v_trade.proposer_team_id
              then v_trade.recipient_team_id else v_trade.proposer_team_id end;
    perform fsnv2.ensure_waiver_state(v_trade.league_id, v_item.sender_team_id);
    perform fsnv2.ensure_waiver_state(v_trade.league_id, v_to);

    update fsnv2.team_waiver_state
       set faab_balance = faab_balance - v_item.amount
     where league_id = v_trade.league_id and team_id = v_item.sender_team_id;
    update fsnv2.team_waiver_state
       set faab_balance = faab_balance + v_item.amount
     where league_id = v_trade.league_id and team_id = v_to;

    v_moves := v_moves || jsonb_build_array(jsonb_build_object(
      'asset_type', 'FAAB', 'amount', v_item.amount,
      'from_team_id', v_item.sender_team_id, 'to_team_id', v_to));
  end loop;

  -- And the picks. `current_team_id` is the whole transfer: the pick's
  -- identity — whose it originally was, which round of which season — is the
  -- one thing a trade must never rewrite, because that is what "Charlie's 2027
  -- second" means two trades later.
  --
  -- The `used_by_pick_id is null` in the WHERE is not redundant with
  -- `assert_trade_valid` above. It is the same posture the roster moves take:
  -- the check that refuses the trade and the write that performs it look at
  -- the same row in the same transaction, so a selection made between them
  -- cannot be traded away after the fact.
  for v_item in
    select i.* from fsnv2.trade_items i
     where i.trade_id = p_trade_id and i.asset_type = 'DRAFT_PICK'
     order by i.asset_id
  loop
    v_to := case when v_item.sender_team_id = v_trade.proposer_team_id
              then v_trade.recipient_team_id else v_trade.proposer_team_id end;

    update fsnv2.draft_pick_assets a
       set current_team_id = v_to
     where a.id = v_item.asset_id::uuid
       and a.league_id = v_trade.league_id
       and a.current_team_id = v_item.sender_team_id
       and a.used_by_pick_id is null
    returning * into v_asset;

    if not found then
      raise exception '% could not be transferred — it has been used or traded on since',
        coalesce((select fsnv2.draft_pick_label(a, v_draft) from fsnv2.draft_pick_assets a
                   where a.id = v_item.asset_id::uuid), v_item.asset_id)
        using errcode = 'P0001';
    end if;

    v_moves := v_moves || jsonb_build_array(jsonb_build_object(
      'asset_type',   'DRAFT_PICK',
      'asset_id',     v_item.asset_id,
      'from_team_id', v_item.sender_team_id,
      'to_team_id',   v_to,
      'draft_pick',   fsnv2.draft_pick_card(v_item.asset_id, v_draft)));
  end loop;

  update fsnv2.trades
     set status = 'EXECUTED', executed_at = v_at,
         effective_week = coalesce(effective_week, v_week),
         status_detail = null
   where id = p_trade_id
  returning * into v_trade;

  v_payload := fsnv2.trade_payload(p_trade_id)
               || jsonb_build_object('moves', v_moves, 'week', v_week,
                                     'was_deferred', v_trade.deferred_from_week is not null);

  -- The Trade Breakdown's source of truth.
  perform fsnv2.emit_league_event(
    v_trade.league_id, 'TRADE_EXECUTED', v_payload, 'trade', p_trade_id::text,
    v_at, v_week, v_season, 'trade-executed:' || p_trade_id::text);

  return v_payload;
end;
$$;


-- =============================================================================
-- Grants
--
-- Seeding and the reads sit with the rest of league setup —
-- `fsnv2_generate_schedule` is granted the same way, and both are idempotent
-- operations a commissioner performs from the app. Transferring a pick is not
-- here at all: it happens inside `fsnv2_execute_trade`, which stays
-- service_role only, so the only way a pick changes hands is a trade both
-- teams agreed to.
--
-- `fsnv2_record_pick` and `fsnv2_draft_state` keep 0002's grants: `create or
-- replace` on the same signature replaces the body, not the privileges.
-- =============================================================================
grant execute on function
  public.fsnv2_seed_draft_picks(uuid, integer, integer, text),
  public.fsnv2_draft_pick_ledger(uuid, integer, integer),
  public.fsnv2_draft_order(uuid, integer),
  public.fsnv2_draft_pick_owner(uuid, integer)
to anon, authenticated, service_role;

-- Same reason as 0008, 0013 and 0014: PostgREST answers from a cached copy of
-- the catalog, so a freshly created function is invisible until it refreshes.
notify pgrst, 'reload schema';
