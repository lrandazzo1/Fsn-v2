-- =============================================================================
-- FSN v2 — Waiver wire / free agency, the trade engine, and the league event
-- log the News Desk reads.
--
-- Migration 0013 made a lineup honest: a player stops being movable the moment
-- their real game starts. That settled *who plays this week*. It said nothing
-- about *who is on the roster at all* — every roster in the league was still
-- exactly what the draft produced in 0001, because `fsnv2.draft_picks` was the
-- only way a player had ever been acquired.
--
-- This migration opens the two doors that change a roster after the draft:
--
--   the waiver wire   a sealed-bid FAAB auction, processed in one transaction
--                     on a schedule, with a rolling priority list as tiebreak
--   trades            a two-sided proposal with an expiry, an accept/reject
--                     handshake, and an atomic swap guarded by 0013's lock
--
-- and the one thing both feed:
--
--   the event log      `fsnv2.league_events`, a bitemporal record of what
--                      happened and when we learned it, which the automated
--                      News Desk and Beat Reporter pipelines drain to write
--                      Trade Breakdown and Waiver Article recaps.
--
-- -----------------------------------------------------------------------------
-- A note on names
-- -----------------------------------------------------------------------------
-- The brief for this work names the tables `fsnv2_waiver_bids`, `fsnv2_trades`,
-- `fsnv2_trade_items` and `fsnv2_league_events`. In this project the `fsnv2`
-- prefix *is* the schema (see 0001: `fsnv2.players`, not `fsnv2_players`), so
-- those four tables are created here as
--
--   fsnv2.waiver_bids      fsnv2.trades      fsnv2.trade_items
--   fsnv2.league_events
--
-- and the `public.fsnv2_*` prefix is kept for the RPC surface, which is the
-- only thing a client ever names. Nothing is renamed; the prefix just lives
-- where the rest of the engine keeps it.
--
-- -----------------------------------------------------------------------------
-- The roster of record
-- -----------------------------------------------------------------------------
-- There is no `rosters` table in this schema and this migration does not add
-- one. A team's roster is the set of `fsnv2.draft_picks` rows carrying its
-- `team_id`, and `fsnv2.lineups` maps those players to slots. A waiver claim
-- and a trade therefore *write draft_picks* — an acquisition is a synthetic
-- pick with `source = 'waiver'` or `'trade'`, numbered above the draft's own
-- pick range so it can never collide with one, and a drop is the deletion of
-- that row. Free agency is the absence of a row: a player nobody holds in the
-- league's active draft is a free agent, which is why no `free_agents` table
-- appears here either.
--
-- Keeping one roster of record is the whole point. A parallel table would mean
-- `fsnv2_lineup_state`, `fsnv2_simulate_week` and the draft board could each
-- disagree about who is on a team, and the first bug would be a player
-- starting for two franchises in the same week.
-- =============================================================================

-- ---------------------------------------------------------- league settings --
-- Waiver rules live next to the roster rules they constrain. Defaulted as a
-- whole so every existing league gets the standard $100 FAAB budget without a
-- backfill, and read through `fsnv2.waiver_settings()` so a missing key in a
-- hand-edited row cannot break processing.
alter table fsnv2.leagues
  add column if not exists waiver_settings jsonb not null default jsonb_build_object(
    'mode',    'faab',    -- 'faab' | 'priority' (priority = bid_amount is ignored)
    'budget',  100,       -- opening FAAB balance for every team
    'min_bid', 0,         -- the smallest bid that is not a no-op
    'tiebreak', 'rolling' -- the winner drops to the back of the priority list
  );

-- -------------------------------------------------------- per-team FAAB/priority --
-- One row per franchise per league: what it has left to spend, and where it
-- sits in the waiver order. Created on demand by `fsnv2.ensure_waiver_state()`
-- so a league that was drafted before this migration needs no backfill.
create table if not exists fsnv2.team_waiver_state (
  league_id       uuid not null references fsnv2.leagues(id) on delete cascade,
  team_id         integer not null check (team_id >= 1),
  faab_balance    numeric(10,2) not null default 100 check (faab_balance >= 0),
  waiver_priority integer not null check (waiver_priority >= 1),
  claims_won      integer not null default 0 check (claims_won >= 0),
  updated_at      timestamptz not null default now(),
  primary key (league_id, team_id)
);

-- ------------------------------------------------------------- waiver bids --
-- A sealed bid: "I will pay `bid_amount` for `player_id`, and I will drop
-- `drop_player_id` to make room." Nothing happens when it is submitted — the
-- row sits PENDING until `fsnv2_process_waivers` runs.
--
-- `priority` is the *team's own* ordering of its own bids (1 is the bid it
-- wants most), which is what decides which of a team's claims survives when
-- two of them name the same player to drop. It is not the league waiver order:
-- that is `fsnv2.team_waiver_state.waiver_priority`.
--
-- `status` is exactly the five values the brief specifies. The two failures it
-- does not name a code for — a drop player that a winning claim already
-- consumed, and a roster with no room and no drop named — are recorded as
-- FAILED_PLAYER_TAKEN, because in both cases the asset the bid depended on is
-- gone, with `result_detail` carrying the sentence a manager actually reads.
create table if not exists fsnv2.waiver_bids (
  id             uuid primary key default gen_random_uuid(),
  league_id      uuid not null references fsnv2.leagues(id) on delete cascade,
  team_id        integer not null check (team_id >= 1),
  player_id      text not null references fsnv2.players(id),
  drop_player_id text references fsnv2.players(id),
  bid_amount     numeric(10,2) not null default 0 check (bid_amount >= 0),
  priority       integer not null default 1 check (priority >= 1),
  status         text not null default 'PENDING' check (status in (
                   'PENDING',
                   'SUCCESSFUL',
                   'FAILED_INSUFFICIENT_FAAB',
                   'FAILED_PLAYER_TAKEN',
                   'CANCELLED')),
  result_detail  text,
  processed_at   timestamptz,
  created_at     timestamptz not null default now(),
  constraint waiver_bids_distinct_players
    check (drop_player_id is null or drop_player_id <> player_id)
);

-- One live bid per team per target: a second bid on the same player replaces
-- the first rather than stacking two claims on one roster spot.
create unique index if not exists waiver_bids_one_pending_per_target
  on fsnv2.waiver_bids (league_id, team_id, player_id) where status = 'PENDING';

-- The processing order, as an index: see `fsnv2_waiver_board`.
create index if not exists waiver_bids_pending_order_idx
  on fsnv2.waiver_bids (league_id, bid_amount desc, created_at) where status = 'PENDING';
create index if not exists waiver_bids_team_idx on fsnv2.waiver_bids (league_id, team_id, created_at desc);

-- ----------------------------------------------------------------- trades --
-- The envelope. `fsnv2.trade_items` carries what is actually in it.
--
-- PENDING_NEXT_WEEK is the seventh status, and it is the one the brief asks for
-- in requirement 3 rather than in the column list: a trade whose players are
-- mid-game when execute is called is not refused and not executed, it is
-- deferred to `effective_week` and swept up by
-- `fsnv2_process_pending_trades` once the lock lifts. Without it the only
-- honest answers would be "lose the trade" or "move a player whose game is
-- being played", and the second one is the bug 0013 exists to prevent.
create table if not exists fsnv2.trades (
  id                 uuid primary key default gen_random_uuid(),
  league_id          uuid not null references fsnv2.leagues(id) on delete cascade,
  proposer_team_id   integer not null check (proposer_team_id >= 1),
  recipient_team_id  integer not null check (recipient_team_id >= 1),
  status             text not null default 'PENDING' check (status in (
                       'PENDING',
                       'ACCEPTED',
                       'REJECTED',
                       'CANCELLED',
                       'EXECUTED',
                       'VETOED',
                       'PENDING_NEXT_WEEK')),
  expires_at         timestamptz,
  note               text,
  responded_at       timestamptz,
  executed_at        timestamptz,
  deferred_from_week integer check (deferred_from_week between 1 and 18),
  effective_week     integer check (effective_week between 1 and 18),
  status_detail      text,
  created_at         timestamptz not null default now(),
  constraint trades_distinct_teams check (proposer_team_id <> recipient_team_id)
);
create index if not exists trades_league_idx on fsnv2.trades (league_id, created_at desc);
create index if not exists trades_open_idx on fsnv2.trades (league_id, status)
  where status in ('PENDING', 'ACCEPTED', 'PENDING_NEXT_WEEK');

-- ------------------------------------------------------------ trade items --
-- One asset, moving one way. `sender_team_id` is who gives it up, so the
-- receiver is implied: the other team on the trade.
--
--   PLAYER      asset_id is fsnv2.players.id; amount is null
--   FAAB        amount is the dollars moving; asset_id is null
--   DRAFT_PICK  asset_id is a label such as '2027-R2'; see the note on
--               `fsnv2_execute_trade` — there is no pick ledger in this schema
--               yet, so a pick is recorded and reported, not transferred.
--               SUPERSEDED by 0015_fsnv2_draft_pick_ledger.sql, which adds
--               `fsnv2.draft_pick_assets`, stores the ledger row's id in
--               asset_id, and makes the pick actually change hands. The
--               paragraph above is what 0014 did; 0015 is what happens now.
create table if not exists fsnv2.trade_items (
  id             uuid primary key default gen_random_uuid(),
  trade_id       uuid not null references fsnv2.trades(id) on delete cascade,
  sender_team_id integer not null check (sender_team_id >= 1),
  asset_type     text not null check (asset_type in ('PLAYER', 'FAAB', 'DRAFT_PICK')),
  asset_id       text,
  amount         numeric(10,2),
  created_at     timestamptz not null default now(),
  constraint trade_items_player_needs_id
    check (asset_type <> 'PLAYER' or asset_id is not null),
  constraint trade_items_pick_needs_id
    check (asset_type <> 'DRAFT_PICK' or asset_id is not null),
  constraint trade_items_faab_needs_amount
    check (asset_type <> 'FAAB' or (amount is not null and amount > 0))
);
create index if not exists trade_items_trade_idx on fsnv2.trade_items (trade_id);
-- A player cannot appear twice in one trade, in either direction.
create unique index if not exists trade_items_one_side_per_player
  on fsnv2.trade_items (trade_id, asset_id) where asset_type = 'PLAYER';

-- ----------------------------------------------------- the league event log --
-- Bitemporal, in the ordinary sense of the word: two independent clocks.
--
--   valid_from / valid_to   league time — when the fact became true, and when
--                           it stopped being true. A waiver award's valid_from
--                           is the processing instant; a deferred trade's is
--                           the instant it will take effect, which is in the
--                           future at the moment the row is written.
--   recorded_at             transaction time — when this system learned it.
--                           Never back-dated, so "what did the News Desk know
--                           on Tuesday night?" stays answerable after the fact.
--
-- The two come apart in exactly the cases the News Desk cares about: a trade
-- agreed Sunday afternoon but effective next week is *recorded* now and *valid*
-- later, and a correction filed later carries a new recorded_at over the same
-- valid interval. One timestamp cannot express either.
--
-- `dispatch_status` is the pipeline's own cursor, not part of the history:
-- the Beat Reporter claims PENDING rows, writes its article, and marks them
-- DISPATCHED. `dedupe_key` makes a double insert a no-op, so a retried cron
-- run cannot produce two Waiver Articles for one processing run.
create table if not exists fsnv2.league_events (
  id                uuid primary key default gen_random_uuid(),
  league_id         uuid not null references fsnv2.leagues(id) on delete cascade,
  event_type        text not null check (event_type in (
                      'WAIVER_PROCESSED',
                      'WAIVER_CLAIM_AWARDED',
                      'WAIVER_CLAIM_FAILED',
                      'TRADE_PROPOSED',
                      'TRADE_ACCEPTED',
                      'TRADE_REJECTED',
                      'TRADE_CANCELLED',
                      'TRADE_VETOED',
                      'TRADE_DEFERRED',
                      'TRADE_EXECUTED')),
  subject_type      text not null default 'league'
                      check (subject_type in ('league', 'team', 'player', 'trade', 'waiver_bid')),
  subject_id        text,
  season            integer,
  week              integer check (week between 1 and 18),
  valid_from        timestamptz not null default now(),
  valid_to          timestamptz,
  recorded_at       timestamptz not null default now(),
  payload           jsonb not null default '{}'::jsonb,
  dedupe_key        text,
  dispatch_status   text not null default 'PENDING'
                      check (dispatch_status in ('PENDING', 'DISPATCHED', 'SKIPPED', 'FAILED')),
  dispatch_attempts integer not null default 0 check (dispatch_attempts >= 0),
  dispatched_at     timestamptz,
  dispatch_error    text,
  constraint league_events_valid_interval check (valid_to is null or valid_to >= valid_from)
);
create unique index if not exists league_events_dedupe_idx
  on fsnv2.league_events (dedupe_key) where dedupe_key is not null;
-- The league feed, newest first.
create index if not exists league_events_feed_idx
  on fsnv2.league_events (league_id, valid_from desc, recorded_at desc);
-- The pipeline's queue scan.
create index if not exists league_events_pending_idx
  on fsnv2.league_events (recorded_at) where dispatch_status = 'PENDING';

drop trigger if exists team_waiver_state_touch on fsnv2.team_waiver_state;
create trigger team_waiver_state_touch before update on fsnv2.team_waiver_state
  for each row execute function fsnv2.touch_updated_at();

-- Same posture as every other table in this schema: RLS on, no direct-table
-- policies, all access through the security-definer RPCs below.
alter table fsnv2.team_waiver_state enable row level security;
alter table fsnv2.waiver_bids       enable row level security;
alter table fsnv2.trades            enable row level security;
alter table fsnv2.trade_items       enable row level security;
alter table fsnv2.league_events     enable row level security;

-- A roster is acquired three new ways now. The constraint in 0001 allowed only
-- the four draft-time sources, so it has to be widened before a claim can be
-- written; dropping and re-adding is the only way to change a check.
alter table fsnv2.draft_picks drop constraint if exists draft_picks_source_check;
alter table fsnv2.draft_picks add constraint draft_picks_source_check
  check (source in ('manual', 'bot', 'timer_expiry', 'simulation',
                    'waiver', 'trade', 'free_agency'));

-- =============================================================================
-- Internal helpers (fsnv2 schema — not granted, not part of the RPC surface)
--
-- These are the questions both engines ask over and over: which draft holds
-- this league's rosters, who owns this player, is there room, what is this
-- team called. Answering them in one place is what keeps the waiver processor
-- and the trade executor from drifting apart on the definition of a roster.
-- =============================================================================

/* The league's waiver rules, with every key guaranteed present. */
create or replace function fsnv2.waiver_settings(p_league_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('mode','faab','budget',100,'min_bid',0,'tiebreak','rolling')
         || coalesce(l.waiver_settings, '{}'::jsonb)
  from fsnv2.leagues l where l.id = p_league_id;
$$;

/*
 * The draft whose picks *are* this league's rosters.
 *
 * A league in this schema has one draft in practice; when it has more, the
 * most recent completed or in-progress one is the live roster set. A league
 * with no draft has no rosters, and every caller below treats that as an
 * error rather than an empty roster, because silently claiming a player into
 * nowhere is worse than refusing the claim.
 */
create or replace function fsnv2.active_draft(p_league_id uuid)
returns uuid language sql stable as $$
  select d.id from fsnv2.drafts d
   where d.league_id = p_league_id
     and d.status in ('complete', 'in_progress', 'paused')
   order by (d.status = 'complete') desc, d.created_at desc
   limit 1;
$$;

create or replace function fsnv2.require_draft(p_league_id uuid)
returns uuid language plpgsql stable as $$
declare v_draft uuid := fsnv2.active_draft(p_league_id);
begin
  if v_draft is null then
    raise exception 'league % has no drafted roster to transact against', p_league_id
      using errcode = 'P0002';
  end if;
  return v_draft;
end;
$$;

/*
 * How many players a team may hold.
 *
 * Derived from the league's own roster_settings, then capped at 15 — the
 * number of slot keys `fsnv2_lineup_state` (0008) knows how to fill. A league
 * configured for more players than there are slots would hand the lineup
 * builder a roster it cannot lay out, and the first symptom would be a
 * 'roster is full' error on an unrelated read.
 */
create or replace function fsnv2.roster_capacity(p_league_id uuid)
returns integer language sql stable as $$
  select least(15, greatest(1, coalesce(
    (select sum(value::numeric)::integer
       from fsnv2.leagues l, jsonb_each_text(l.roster_settings -> 'starters')
      where l.id = p_league_id)
    + coalesce((select (l.roster_settings ->> 'bench')::integer
                  from fsnv2.leagues l where l.id = p_league_id), 0),
    15)));
$$;

create or replace function fsnv2.roster_size(p_draft_id uuid, p_team_id integer)
returns integer language sql stable as $$
  select count(*)::integer from fsnv2.draft_picks
   where draft_id = p_draft_id and team_id = p_team_id;
$$;

/* Which team holds this player — null for a free agent. */
create or replace function fsnv2.player_owner(p_draft_id uuid, p_player_id text)
returns integer language sql stable as $$
  select team_id from fsnv2.draft_picks
   where draft_id = p_draft_id and player_id = p_player_id limit 1;
$$;

/* The franchise name from drafts.teams, falling back to "Team 4". */
create or replace function fsnv2.team_label(p_draft_id uuid, p_team_id integer)
returns text language sql stable as $$
  select coalesce(
    (select t ->> 'name' from fsnv2.drafts d, jsonb_array_elements(d.teams) t
      where d.id = p_draft_id and (t ->> 'slot')::integer = p_team_id limit 1),
    'Team ' || p_team_id);
$$;

/* Everything an article needs to name a player, in one jsonb object. */
create or replace function fsnv2.player_card(p_player_id text)
returns jsonb language sql stable as $$
  select case when p_player_id is null then null else coalesce(
    (select jsonb_build_object('player_id', p.id, 'name', p.name,
                               'position', p.position, 'team', p.team)
       from fsnv2.players p where p.id = p_player_id),
    jsonb_build_object('player_id', p_player_id)) end;
$$;

/*
 * A dollar amount the way a manager reads it: "$25", not "$25.", and "$7.50"
 * when there are cents. `to_char(…, 'FM999999990.99')` leaves a bare decimal
 * point on a whole number, which is how "Awarded for $25.." got into a result
 * detail once.
 */
create or replace function fsnv2.money(p_amount numeric)
returns text language sql immutable as $$
  select case
    when p_amount is null then '0'
    when p_amount = trunc(p_amount) then trunc(p_amount)::text
    else trim(to_char(p_amount, 'FM999999990.00')) end;
$$;

/* The team slot must be one this league actually has. */
create or replace function fsnv2.require_team(p_league_id uuid, p_team_id integer)
returns void language plpgsql stable as $$
declare v_total integer;
begin
  select total_teams into v_total from fsnv2.leagues where id = p_league_id;
  if not found then
    raise exception 'league % not found', p_league_id using errcode = 'P0002';
  end if;
  if p_team_id is null or p_team_id < 1 or p_team_id > v_total then
    raise exception 'team % is not in this league (1..%)', p_team_id, v_total
      using errcode = 'P0001';
  end if;
end;
$$;

/*
 * The team's FAAB row, created on first use.
 *
 * Opening balance and starting waiver order come from the league: the budget
 * from waiver_settings, the order from the team slot. A real league reseeds the
 * order from inverse standings once week 1 is played —
 * `fsnv2_reset_waiver_priority` does that — but slot order is a defined
 * starting point and never a null.
 */
create or replace function fsnv2.ensure_waiver_state(p_league_id uuid, p_team_id integer)
returns fsnv2.team_waiver_state language plpgsql as $$
declare v_row fsnv2.team_waiver_state;
begin
  insert into fsnv2.team_waiver_state (league_id, team_id, faab_balance, waiver_priority)
  values (p_league_id, p_team_id,
          coalesce((fsnv2.waiver_settings(p_league_id) ->> 'budget')::numeric, 100),
          p_team_id)
  on conflict (league_id, team_id) do nothing;

  select * into v_row from fsnv2.team_waiver_state
   where league_id = p_league_id and team_id = p_team_id;
  return v_row;
end;
$$;

-- =============================================================================
-- The roster write
--
-- Every acquisition and every drop in this migration goes through
-- `fsnv2.apply_roster_change`. It is the only place that writes
-- `fsnv2.draft_picks` outside the draft itself, and the only place that keeps
-- `fsnv2.lineups` in step with it.
--
-- The lineup is patched, not rebuilt, when it can be: a manager who spent
-- Saturday arranging a lineup should not find it re-sorted because they won a
-- kicker on waivers. The dropped player's slot is emptied, and the new player
-- takes that slot if the position fits, otherwise the first open bench slot,
-- otherwise an open starter slot. When no slot can legally hold them — a full
-- roster whose only gap is at a position the new player cannot play — the
-- lineup row is deleted instead, and `fsnv2_lineup_state` rebuilds it greedily
-- on the next read. That is the fallback it already implements for a pick set
-- that no longer matches (0008), so this path adds no new behaviour, only a new
-- reason to take it.
-- =============================================================================

/* Mirrors the eligibility test in fsnv2_swap_lineup (0008/0013). */
create or replace function fsnv2.slot_accepts(p_slot text, p_position text)
returns boolean language sql immutable as $$
  select case
    when p_slot is null or p_position is null then false
    when p_slot like 'BN%' then true
    when p_slot = p_position then true
    when p_slot in ('RB1','RB2') and p_position = 'RB' then true
    when p_slot in ('WR1','WR2') and p_position = 'WR' then true
    when p_slot = 'FLEX' and p_position in ('RB','WR','TE') then true
    else false end;
$$;

create or replace function fsnv2.apply_roster_change(
  p_draft_id uuid,
  p_team_id  integer,
  p_add      text,
  p_drop     text,
  p_source   text default 'waiver'
) returns jsonb
language plpgsql as $$
declare
  v_total      integer;
  v_pick_no    integer;
  v_round      integer;
  v_position   text;
  v_roster     jsonb;
  v_version    integer;
  v_freed_slot text;
  v_slot       text;
  v_candidate  text;
  v_placed     text;
  v_owner      integer;
begin
  if p_add is null and p_drop is null then
    return jsonb_build_object('added', null, 'dropped', null);
  end if;

  if p_drop is not null then
    v_owner := fsnv2.player_owner(p_draft_id, p_drop);
    if v_owner is distinct from p_team_id then
      raise exception 'drop player % is not on team %', p_drop, p_team_id
        using errcode = 'P0001';
    end if;
    delete from fsnv2.draft_picks
     where draft_id = p_draft_id and player_id = p_drop;
  end if;

  if p_add is not null then
    v_owner := fsnv2.player_owner(p_draft_id, p_add);
    if v_owner is not null then
      raise exception 'player % is already on team %', p_add, v_owner
        using errcode = 'P0001';
    end if;
    select position into v_position from fsnv2.players where id = p_add;
    if v_position is null then
      raise exception 'player % is not in the player pool', p_add using errcode = 'P0002';
    end if;

    -- Numbered above the draft's own range so an acquisition can never take a
    -- pick slot the draft still has to use.
    select coalesce(l.total_teams * d.rounds, 0) into v_total
      from fsnv2.drafts d join fsnv2.leagues l on l.id = d.league_id
     where d.id = p_draft_id;
    select greatest(coalesce(max(pick_number), 0), coalesce(v_total, 0)) + 1
      into v_pick_no from fsnv2.draft_picks where draft_id = p_draft_id;
    v_round := greatest(1, ((v_pick_no - 1) / greatest(1, (select total_teams from fsnv2.leagues l
                 join fsnv2.drafts d on d.league_id = l.id where d.id = p_draft_id))) + 1);

    insert into fsnv2.draft_picks (draft_id, pick_number, round, team_id, player_id, auto, source)
    values (p_draft_id, v_pick_no, v_round, p_team_id, p_add, false, p_source);
  end if;

  -- ----------------------------------------------------------- the lineup --
  select roster, version into v_roster, v_version
    from fsnv2.lineups where draft_id = p_draft_id and team_id = p_team_id;
  if not found then
    -- Nothing saved yet: fsnv2_lineup_state builds it from the picks on read.
    return jsonb_build_object('added', p_add, 'dropped', p_drop, 'slot', null);
  end if;

  if p_drop is not null then
    select key into v_freed_slot from jsonb_each_text(v_roster)
     where value = p_drop limit 1;
    if v_freed_slot is not null then
      v_roster := jsonb_set(v_roster, array[v_freed_slot], 'null'::jsonb);
    end if;
  end if;

  if p_add is not null then
    -- The dropped player's own slot first, then the bench, then a starter hole.
    if v_freed_slot is not null and fsnv2.slot_accepts(v_freed_slot, v_position) then
      v_placed := v_freed_slot;
    else
      foreach v_candidate in array array['BN1','BN2','BN3','BN4','BN5','BN6',
                                         'QB','RB1','RB2','WR1','WR2','TE','FLEX','DST','K'] loop
        if v_roster ? v_candidate and v_roster ->> v_candidate is null
           and fsnv2.slot_accepts(v_candidate, v_position) then
          v_placed := v_candidate;
          exit;
        end if;
      end loop;
    end if;

    if v_placed is null then
      -- No slot can legally hold them. Drop the saved map and let
      -- fsnv2_lineup_state lay the roster out again on the next read.
      delete from fsnv2.lineups where draft_id = p_draft_id and team_id = p_team_id;
      return jsonb_build_object('added', p_add, 'dropped', p_drop, 'slot', null,
                                'lineup_rebuilt', true);
    end if;
    v_roster := jsonb_set(v_roster, array[v_placed], to_jsonb(p_add));
  end if;

  update fsnv2.lineups
     set roster = v_roster, version = v_version + 1
   where draft_id = p_draft_id and team_id = p_team_id;

  return jsonb_build_object('added', p_add, 'dropped', p_drop, 'slot', v_placed,
                            'freed_slot', v_freed_slot, 'version', v_version + 1);
end;
$$;

-- =============================================================================
-- The media event dispatcher
--
-- Requirement 4: when waivers process or a trade executes, the News Desk and
-- Beat Reporter pipelines must be able to write the recap *immediately*,
-- without polling rosters to work out what changed. So the engines below do
-- not just mutate state — they state what happened, in the same transaction,
-- with the article's facts already in the payload: who, from whom, for how
-- much, instead of what.
--
-- The payload is deliberately denormalised. A Trade Breakdown written three
-- weeks later must still say "Jonathan Taylor (RB, IND)" even if the player has
-- since been cut and re-signed elsewhere, and a join at render time would
-- quietly rewrite history. The event carries what was true when it happened;
-- that is the whole reason for the valid/recorded split above.
-- =============================================================================

create or replace function fsnv2.emit_league_event(
  p_league_id    uuid,
  p_event_type   text,
  p_payload      jsonb,
  p_subject_type text default 'league',
  p_subject_id   text default null,
  p_valid_from   timestamptz default now(),
  p_week         integer default null,
  p_season       integer default null,
  p_dedupe_key   text default null,
  p_dispatch     text default 'PENDING'
) returns uuid
language plpgsql as $$
declare v_id uuid;
begin
  -- `p_dispatch = 'SKIPPED'` files an event for the league feed without
  -- putting it in the Beat Reporter's queue. Every manager's failed claim is
  -- worth showing them; none of them is worth an article.
  insert into fsnv2.league_events (
    league_id, event_type, subject_type, subject_id,
    season, week, valid_from, payload, dedupe_key, dispatch_status
  ) values (
    p_league_id, p_event_type, p_subject_type, p_subject_id,
    coalesce(p_season, public.fsnv2_current_nfl_season(coalesce(p_valid_from, now()))),
    coalesce(p_week, public.fsnv2_current_nfl_week(coalesce(p_valid_from, now()))),
    coalesce(p_valid_from, now()),
    coalesce(p_payload, '{}'::jsonb),
    p_dedupe_key,
    coalesce(p_dispatch, 'PENDING')
  )
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning id into v_id;

  -- A retried cron run re-emits the same key; the first row stands and the
  -- pipeline sees one article's worth of facts, not two.
  if v_id is null and p_dedupe_key is not null then
    select id into v_id from fsnv2.league_events where dedupe_key = p_dedupe_key;
  end if;
  return v_id;
end;
$$;

/*
 * The league feed: what the activity tab and the Beat Reporter's context
 * window read. Ordered by league time, newest first.
 */
create or replace function public.fsnv2_league_feed(
  p_league_id   uuid,
  p_since       timestamptz default null,
  p_limit       integer default 50,
  p_event_types text[] default null
) returns jsonb
language sql stable security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(to_jsonb(e) order by e.valid_from desc, e.recorded_at desc), '[]'::jsonb)
  from (
    select id, league_id, event_type, subject_type, subject_id, season, week,
           valid_from, valid_to, recorded_at, payload, dispatch_status
      from fsnv2.league_events
     where league_id = p_league_id
       and (p_since is null or valid_from >= p_since)
       and (p_event_types is null or event_type = any(p_event_types))
     order by valid_from desc, recorded_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 500))
  ) e;
$$;

/*
 * The pipeline's intake. Claims up to `p_limit` undispatched events and hands
 * them over, marked DISPATCHED, in one statement — `skip locked` so two
 * Beat Reporter workers never write the same article twice.
 *
 * A worker that fails after claiming calls `fsnv2_complete_league_event` with
 * ok = false, which files the error and puts the row back in the queue.
 */
create or replace function public.fsnv2_claim_league_events(
  p_limit     integer default 20,
  p_league_id uuid default null
) returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  with due as (
    select id from fsnv2.league_events
     where dispatch_status = 'PENDING'
       and (p_league_id is null or league_id = p_league_id)
     order by recorded_at
     limit greatest(1, least(coalesce(p_limit, 20), 200))
     for update skip locked
  ), claimed as (
    update fsnv2.league_events e
       set dispatch_status   = 'DISPATCHED',
           dispatched_at     = now(),
           dispatch_attempts = e.dispatch_attempts + 1,
           dispatch_error    = null
     where e.id in (select id from due)
    returning e.*
  )
  select coalesce(jsonb_agg(to_jsonb(c) order by c.recorded_at), '[]'::jsonb) from claimed c;
$$;

/* A claimed event's outcome. ok = false returns it to the queue. */
create or replace function public.fsnv2_complete_league_event(
  p_event_id uuid,
  p_ok       boolean default true,
  p_error    text default null
) returns jsonb
language sql security definer set search_path = fsnv2, public as $$
  update fsnv2.league_events
     set dispatch_status = case when p_ok then 'DISPATCHED' else 'PENDING' end,
         dispatch_error  = case when p_ok then null else p_error end
   where id = p_event_id
  returning to_jsonb(fsnv2.league_events.*);
$$;

-- =============================================================================
-- Free agency
--
-- A free agent is a player no team holds in this league's active draft. There
-- is no pool table to keep in step — the absence of a draft_picks row *is* the
-- pool, so a player released by one team is available to the rest of the
-- league in the same transaction.
-- =============================================================================

create or replace function public.fsnv2_free_agents(
  p_league_id uuid,
  p_position  text default null,
  p_limit     integer default 100,
  p_search    text default null
) returns jsonb
language sql stable security definer set search_path = fsnv2, public as $$
  with draft as (select fsnv2.active_draft(p_league_id) as id)
  select coalesce(jsonb_agg(to_jsonb(f) order by f.adp, f.name), '[]'::jsonb)
  from (
    select p.id as player_id, p.name, p.position, p.team, p.adp, p.stats
      from fsnv2.players p, draft
     where (p_position is null or p.position = upper(p_position))
       and (p_search is null or p.name ilike '%' || p_search || '%')
       and not exists (
         select 1 from fsnv2.draft_picks k
          where k.draft_id = draft.id and k.player_id = p.id)
     order by p.adp, p.name
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) f;
$$;

-- =============================================================================
-- The waiver wire
--
-- Submitting a bid writes a row and nothing else. The auction is settled in one
-- transaction by `fsnv2_process_waivers`, which the cron worker at
-- /api/waivers/process calls.
--
-- Validation happens twice on purpose — once here, so a manager gets an
-- immediate, explainable refusal, and again during processing, because
-- everything a bid depends on (the player's availability, the team's balance,
-- the roster spot the drop was going to free) can change between Tuesday night
-- and Wednesday morning.
-- =============================================================================

/* FAAB, waiver order and open bids for every team in the league. */
create or replace function public.fsnv2_waiver_state(p_league_id uuid)
returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare v_total integer; v_team integer;
begin
  select total_teams into v_total from fsnv2.leagues where id = p_league_id;
  if not found then
    raise exception 'league % not found', p_league_id using errcode = 'P0002';
  end if;

  -- Every franchise gets a row on first read, so the UI never has to special
  -- case "this team has not bid yet".
  for v_team in 1 .. v_total loop
    perform fsnv2.ensure_waiver_state(p_league_id, v_team);
  end loop;

  return jsonb_build_object(
    'league_id', p_league_id,
    'settings',  fsnv2.waiver_settings(p_league_id),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
               'team_id',         w.team_id,
               'team_name',       fsnv2.team_label(fsnv2.active_draft(p_league_id), w.team_id),
               'faab_balance',    w.faab_balance,
               'waiver_priority', w.waiver_priority,
               'claims_won',      w.claims_won,
               'pending_bids',    (select count(*) from fsnv2.waiver_bids b
                                    where b.league_id = w.league_id and b.team_id = w.team_id
                                      and b.status = 'PENDING')
             ) order by w.waiver_priority)
        from fsnv2.team_waiver_state w where w.league_id = p_league_id), '[]'::jsonb)
  );
end;
$$;

/*
 * Re-seeds the waiver order from inverse standings — worst record picks first.
 * Run after a week is finalised; the rolling rotation inside processing takes
 * over from there.
 */
create or replace function public.fsnv2_reset_waiver_priority(p_league_id uuid)
returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare v_team integer; v_total integer;
begin
  select total_teams into v_total from fsnv2.leagues where id = p_league_id;
  if not found then
    raise exception 'league % not found', p_league_id using errcode = 'P0002';
  end if;
  for v_team in 1 .. v_total loop
    perform fsnv2.ensure_waiver_state(p_league_id, v_team);
  end loop;

  with standing as (
    select (s ->> 'team_id')::integer as team_id,
           coalesce((s ->> 'wins')::integer, 0) as wins,
           coalesce((s ->> 'points_for')::numeric, 0) as points_for
      from jsonb_array_elements(public.fsnv2_season_standings(p_league_id)) s
  ), ranked as (
    select w.team_id,
           row_number() over (
             order by coalesce(st.wins, 0) asc,
                      coalesce(st.points_for, 0) asc,
                      w.team_id asc) as seed
      from fsnv2.team_waiver_state w
      left join standing st on st.team_id = w.team_id
     where w.league_id = p_league_id
  )
  update fsnv2.team_waiver_state w
     set waiver_priority = r.seed
    from ranked r
   where w.league_id = p_league_id and w.team_id = r.team_id;

  return public.fsnv2_waiver_state(p_league_id);
end;
$$;

/* The winner drops to the back; everyone behind them moves up one. */
create or replace function fsnv2.rotate_waiver_priority(p_league_id uuid, p_team_id integer)
returns void language plpgsql as $$
declare v_was integer;
begin
  select waiver_priority into v_was from fsnv2.team_waiver_state
   where league_id = p_league_id and team_id = p_team_id;
  if v_was is null then return; end if;

  update fsnv2.team_waiver_state
     set waiver_priority = waiver_priority - 1
   where league_id = p_league_id and waiver_priority > v_was;

  update fsnv2.team_waiver_state
     set waiver_priority = (select coalesce(max(waiver_priority), 0) + 1
                              from fsnv2.team_waiver_state where league_id = p_league_id)
   where league_id = p_league_id and team_id = p_team_id;
end;
$$;

create or replace function public.fsnv2_submit_waiver_bid(
  p_league_id      uuid,
  p_team_id        integer,
  p_player_id      text,
  p_drop_player_id text default null,
  p_bid_amount     numeric default 0,
  p_priority       integer default null
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_draft    uuid;
  v_settings jsonb;
  v_state    fsnv2.team_waiver_state;
  v_owner    integer;
  v_bid      fsnv2.waiver_bids;
  v_priority integer;
begin
  perform fsnv2.require_team(p_league_id, p_team_id);
  v_draft    := fsnv2.require_draft(p_league_id);
  v_settings := fsnv2.waiver_settings(p_league_id);
  v_state    := fsnv2.ensure_waiver_state(p_league_id, p_team_id);

  if not exists (select 1 from fsnv2.players where id = p_player_id) then
    raise exception 'player % is not in the player pool', p_player_id using errcode = 'P0002';
  end if;

  v_owner := fsnv2.player_owner(v_draft, p_player_id);
  if v_owner is not null then
    raise exception '% is already on team %''s roster',
      (select name from fsnv2.players where id = p_player_id), v_owner
      using errcode = 'P0001';
  end if;

  if p_drop_player_id is not null then
    if p_drop_player_id = p_player_id then
      raise exception 'a bid cannot drop the player it is claiming' using errcode = 'P0001';
    end if;
    if fsnv2.player_owner(v_draft, p_drop_player_id) is distinct from p_team_id then
      raise exception '% is not on your roster',
        coalesce((select name from fsnv2.players where id = p_drop_player_id), p_drop_player_id)
        using errcode = 'P0001';
    end if;
  elsif fsnv2.roster_size(v_draft, p_team_id) >= fsnv2.roster_capacity(p_league_id) then
    raise exception 'your roster is full — name a player to drop with this bid'
      using errcode = 'P0001';
  end if;

  -- In priority-order leagues the money is ignored, so a bid that names one is
  -- recorded at zero rather than quietly treated as a tiebreak that does not
  -- exist.
  if coalesce(v_settings ->> 'mode', 'faab') <> 'faab' then
    p_bid_amount := 0;
  else
    if p_bid_amount is null or p_bid_amount < 0 then
      raise exception 'a bid cannot be negative' using errcode = 'P0001';
    end if;
    if p_bid_amount < coalesce((v_settings ->> 'min_bid')::numeric, 0) then
      raise exception 'the minimum bid in this league is %', v_settings ->> 'min_bid'
        using errcode = 'P0001';
    end if;
    if p_bid_amount > v_state.faab_balance then
      raise exception 'bid of % exceeds your remaining FAAB budget of %',
        p_bid_amount, v_state.faab_balance using errcode = 'P0001';
    end if;
  end if;

  -- The team's own ordering of its own bids: defaults to the back of its board.
  select coalesce(p_priority, coalesce(max(priority), 0) + 1) into v_priority
    from fsnv2.waiver_bids
   where league_id = p_league_id and team_id = p_team_id and status = 'PENDING';

  insert into fsnv2.waiver_bids (
    league_id, team_id, player_id, drop_player_id, bid_amount, priority)
  values (p_league_id, p_team_id, p_player_id, p_drop_player_id, p_bid_amount, v_priority)
  on conflict (league_id, team_id, player_id) where status = 'PENDING'
    do update set drop_player_id = excluded.drop_player_id,
                  bid_amount     = excluded.bid_amount,
                  priority       = excluded.priority,
                  created_at     = now()
  returning * into v_bid;

  return to_jsonb(v_bid);
end;
$$;

create or replace function public.fsnv2_cancel_waiver_bid(
  p_bid_id  uuid,
  p_team_id integer default null
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare v_bid fsnv2.waiver_bids;
begin
  update fsnv2.waiver_bids
     set status = 'CANCELLED', result_detail = 'withdrawn by the manager', processed_at = now()
   where id = p_bid_id
     and status = 'PENDING'
     and (p_team_id is null or team_id = p_team_id)
  returning * into v_bid;

  if not found then
    raise exception 'no pending bid % to cancel', p_bid_id using errcode = 'P0002';
  end if;
  return to_jsonb(v_bid);
end;
$$;

/*
 * The board, in the exact order `fsnv2_process_waivers` will walk it:
 *
 *   bid_amount      desc    the auction
 *   waiver_priority asc     the league's rolling order breaks a tie on money
 *   created_at      asc     and the earlier bid breaks a tie on both
 *   priority        asc     then the team's own ranking of its own bids
 *
 * Mirrored by `sortWaiverBids()` in js/transactions.js so the UI can show a
 * manager where their claim actually sits without asking the server, and
 * tests/transactions.test.mjs holds the two to the same answer.
 */
create or replace function public.fsnv2_waiver_board(p_league_id uuid)
returns jsonb
language sql stable security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(to_jsonb(o) order by o.processing_order), '[]'::jsonb)
  from (
    select row_number() over (
             order by b.bid_amount desc, coalesce(w.waiver_priority, b.team_id) asc,
                      b.created_at asc, b.priority asc, b.id asc) as processing_order,
           b.id as bid_id, b.team_id, b.player_id, b.drop_player_id,
           b.bid_amount, b.priority, b.created_at,
           coalesce(w.waiver_priority, b.team_id) as waiver_priority,
           fsnv2.player_card(b.player_id)      as player,
           fsnv2.player_card(b.drop_player_id) as drop_player
      from fsnv2.waiver_bids b
      left join fsnv2.team_waiver_state w
             on w.league_id = b.league_id and w.team_id = b.team_id
     where b.league_id = p_league_id and b.status = 'PENDING'
  ) o;
$$;

-- =============================================================================
-- Processing — requirement 2, and the only transaction in this file that can
-- change more than one franchise's roster.
--
-- The order is the auction:
--
--   bid_amount DESC  ->  waiver_priority ASC  ->  created_at ASC
--
-- and it is evaluated *globally* within the league, not per player. Grouping by
-- player and settling each group independently looks equivalent and is not: a
-- team's FAAB pays for every claim it wins, and a bid's drop player can only be
-- dropped once. Walking one ordered list and re-reading the balance and the
-- roster at each step is what makes "deduct FAAB, move the player, move the
-- dropped player to free agency, invalidate the bids that depended on that
-- drop" come out consistent — the second claim a team wins is checked against
-- the money the first one already spent.
--
-- Everything below happens in the caller's transaction. A failure anywhere
-- rolls back every claim in the run, which is the only acceptable outcome: a
-- half-processed waiver wire means two teams hold the same player.
-- =============================================================================

create or replace function fsnv2.process_league_waivers(
  p_league_id uuid,
  p_at        timestamptz
) returns jsonb
language plpgsql as $$
declare
  v_draft      uuid;
  v_settings   jsonb;
  v_capacity   integer;
  v_season     integer;
  v_week       integer;
  v_bid        record;
  v_status     text;
  v_detail     text;
  v_balance    numeric;
  v_owner      integer;
  v_move       jsonb;
  v_claim      jsonb;
  v_claims     jsonb := '[]'::jsonb;
  v_failures   jsonb := '[]'::jsonb;
  v_cascade    jsonb;
  v_considered integer := 0;   -- every bid in the run
  v_evaluated  integer := 0;   -- the ones reached before a cascade resolved them
  v_awarded    integer := 0;
  v_spent      numeric := 0;
begin
  -- One league at a time. The league row is the lock the lineup swap in 0013
  -- takes on the draft: it serialises two cron runs that overlap, and it
  -- serialises this run against a manager submitting a bid mid-processing.
  perform 1 from fsnv2.leagues where id = p_league_id for update;
  if not found then
    raise exception 'league % not found', p_league_id using errcode = 'P0002';
  end if;

  v_draft    := fsnv2.require_draft(p_league_id);
  v_settings := fsnv2.waiver_settings(p_league_id);
  v_capacity := fsnv2.roster_capacity(p_league_id);
  v_season   := public.fsnv2_current_nfl_season(p_at);
  v_week     := public.fsnv2_current_nfl_week(p_at);

  -- Every franchise, not only the ones that bid: `rotate_waiver_priority`
  -- renumbers the list it can see, so a league whose quiet teams had no row
  -- would end up with gaps in the waiver order after the first award.
  select count(*) into v_considered from fsnv2.waiver_bids
   where league_id = p_league_id and status = 'PENDING';

  insert into fsnv2.team_waiver_state (league_id, team_id, faab_balance, waiver_priority)
  select p_league_id, t.slot, coalesce((v_settings ->> 'budget')::numeric, 100), t.slot
    from generate_series(1, (select total_teams from fsnv2.leagues where id = p_league_id)) t(slot)
  on conflict (league_id, team_id) do nothing;

  for v_bid in
    select b.id, b.team_id, b.player_id, b.drop_player_id, b.bid_amount, b.priority,
           coalesce(w.waiver_priority, b.team_id) as waiver_priority
      from fsnv2.waiver_bids b
      left join fsnv2.team_waiver_state w
             on w.league_id = b.league_id and w.team_id = b.team_id
     where b.league_id = p_league_id and b.status = 'PENDING'
     order by b.bid_amount desc,
              coalesce(w.waiver_priority, b.team_id) asc,
              b.created_at asc,
              b.priority asc,
              b.id asc
  loop
    -- The cursor's snapshot fixes the order; the row itself may already have
    -- been resolved by an award earlier in this same loop — a lower bid on the
    -- player that was just awarded, or a claim whose drop has been spent. Those
    -- are counted in the run (`considered`) but never walked.
    select status into v_status from fsnv2.waiver_bids where id = v_bid.id;
    if v_status is distinct from 'PENDING' then
      continue;
    end if;

    v_evaluated := v_evaluated + 1;
    v_status := null;
    v_detail := null;

    select faab_balance into v_balance from fsnv2.team_waiver_state
     where league_id = p_league_id and team_id = v_bid.team_id;
    v_owner := fsnv2.player_owner(v_draft, v_bid.player_id);

    if v_owner is not null then
      v_status := 'FAILED_PLAYER_TAKEN';
      v_detail := format('%s was already on %s''s roster.',
                    coalesce((select name from fsnv2.players where id = v_bid.player_id),
                             v_bid.player_id),
                    fsnv2.team_label(v_draft, v_owner));

    elsif v_bid.bid_amount > coalesce(v_balance, 0) then
      v_status := 'FAILED_INSUFFICIENT_FAAB';
      v_detail := format('The bid of $%s was more than the $%s left in the budget.',
                    fsnv2.money(v_bid.bid_amount), fsnv2.money(coalesce(v_balance, 0)));

    elsif v_bid.drop_player_id is not null
          and fsnv2.player_owner(v_draft, v_bid.drop_player_id) is distinct from v_bid.team_id then
      -- Recorded as FAILED_PLAYER_TAKEN: the asset this bid depended on is
      -- gone. See the note on the status column.
      v_status := 'FAILED_PLAYER_TAKEN';
      v_detail := format('%s had already left the roster, so there was no room for this claim.',
                    coalesce((select name from fsnv2.players where id = v_bid.drop_player_id),
                             v_bid.drop_player_id));

    elsif v_bid.drop_player_id is not null and public.fsnv2_player_locked(
            (select team from fsnv2.players where id = v_bid.drop_player_id),
            v_season, v_week, p_at) then
      -- 0013's rule, on the other side of the transaction: a player whose game
      -- has started cannot be moved, and dropping them is a move.
      v_status := 'FAILED_PLAYER_TAKEN';
      v_detail := format('%s is locked because their game has already started.',
                    coalesce((select name from fsnv2.players where id = v_bid.drop_player_id),
                             v_bid.drop_player_id));

    elsif v_bid.drop_player_id is null
          and fsnv2.roster_size(v_draft, v_bid.team_id) >= v_capacity then
      v_status := 'FAILED_PLAYER_TAKEN';
      v_detail := 'The roster was full and the bid named no player to drop.';
    end if;

    if v_status is not null then
      update fsnv2.waiver_bids
         set status = v_status, result_detail = v_detail, processed_at = p_at
       where id = v_bid.id;

      v_failures := v_failures || jsonb_build_array(jsonb_build_object(
        'bid_id', v_bid.id, 'team_id', v_bid.team_id, 'status', v_status,
        'detail', v_detail, 'player', fsnv2.player_card(v_bid.player_id)));

      -- The manager's own feed, not the Beat Reporter's queue.
      perform fsnv2.emit_league_event(
        p_league_id, 'WAIVER_CLAIM_FAILED',
        jsonb_build_object(
          'team_id', v_bid.team_id,
          'team_name', fsnv2.team_label(v_draft, v_bid.team_id),
          'player', fsnv2.player_card(v_bid.player_id),
          'bid_amount', v_bid.bid_amount,
          'status', v_status,
          'detail', v_detail),
        'team', v_bid.team_id::text, p_at, v_week, v_season,
        'waiver-claim-failed:' || v_bid.id::text, 'SKIPPED');
      continue;
    end if;

    -- ------------------------------------------------------------- the award --
    v_move := fsnv2.apply_roster_change(
      v_draft, v_bid.team_id, v_bid.player_id, v_bid.drop_player_id, 'waiver');

    update fsnv2.team_waiver_state
       set faab_balance = faab_balance - v_bid.bid_amount,
           claims_won   = claims_won + 1
     where league_id = p_league_id and team_id = v_bid.team_id;

    update fsnv2.waiver_bids
       set status = 'SUCCESSFUL',
           result_detail = format('Awarded for $%s.', fsnv2.money(v_bid.bid_amount)),
           processed_at = p_at
     where id = v_bid.id;

    if coalesce(v_settings ->> 'tiebreak', 'rolling') = 'rolling' then
      perform fsnv2.rotate_waiver_priority(p_league_id, v_bid.team_id);
    end if;

    v_awarded := v_awarded + 1;
    v_spent   := v_spent + v_bid.bid_amount;

    -- Everyone else who wanted this player: the player is gone, whatever they
    -- bid. This is the one place a lower bid is resolved without being walked.
    with invalidated as (
      update fsnv2.waiver_bids b
         set status = 'FAILED_PLAYER_TAKEN',
             result_detail = format('%s was awarded to %s.',
               coalesce((select name from fsnv2.players where id = v_bid.player_id), v_bid.player_id),
               fsnv2.team_label(v_draft, v_bid.team_id)),
             processed_at = p_at
       where b.league_id = p_league_id and b.status = 'PENDING'
         and b.player_id = v_bid.player_id and b.id <> v_bid.id
      returning b.id, b.team_id, b.result_detail
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'bid_id', i.id, 'team_id', i.team_id, 'status', 'FAILED_PLAYER_TAKEN',
             'detail', i.result_detail, 'player', fsnv2.player_card(v_bid.player_id))), '[]'::jsonb)
      into v_cascade from invalidated i;
    v_failures := v_failures || v_cascade;

    -- And this team's remaining claims that were going to free the same roster
    -- spot: the drop has been spent, so the spot they counted on is not there.
    if v_bid.drop_player_id is not null then
      with invalidated as (
        update fsnv2.waiver_bids b
           set status = 'FAILED_PLAYER_TAKEN',
               result_detail = format('%s was already dropped for the winning claim on %s.',
                 coalesce((select name from fsnv2.players where id = v_bid.drop_player_id),
                          v_bid.drop_player_id),
                 coalesce((select name from fsnv2.players where id = v_bid.player_id),
                          v_bid.player_id)),
               processed_at = p_at
         where b.league_id = p_league_id and b.status = 'PENDING'
           and b.team_id = v_bid.team_id
           and b.drop_player_id = v_bid.drop_player_id
           and b.id <> v_bid.id
        returning b.id, b.team_id, b.player_id, b.result_detail
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'bid_id', i.id, 'team_id', i.team_id, 'status', 'FAILED_PLAYER_TAKEN',
               'detail', i.result_detail, 'player', fsnv2.player_card(i.player_id))), '[]'::jsonb)
        into v_cascade from invalidated i;
      v_failures := v_failures || v_cascade;
    end if;

    -- --------------------------------------------- the Waiver Article's facts --
    v_claim := jsonb_build_object(
      'bid_id',      v_bid.id,
      'team_id',     v_bid.team_id,
      'team_name',   fsnv2.team_label(v_draft, v_bid.team_id),
      'bid_amount',  v_bid.bid_amount,
      'faab_before', v_balance,
      'faab_after',  v_balance - v_bid.bid_amount,
      'added',       fsnv2.player_card(v_bid.player_id),
      'dropped',     fsnv2.player_card(v_bid.drop_player_id),
      'slot',        v_move -> 'slot',
      'week',        v_week);
    v_claims := v_claims || jsonb_build_array(v_claim);

    perform fsnv2.emit_league_event(
      p_league_id, 'WAIVER_CLAIM_AWARDED', v_claim,
      'player', v_bid.player_id, p_at, v_week, v_season,
      'waiver-claim:' || v_bid.id::text);
  end loop;

  -- One summary per run, which is what the Waiver Article is written from: the
  -- whole wire in one payload, so the Beat Reporter does not have to stitch
  -- individual claims back together to find the story.
  if v_considered > 0 then
    perform fsnv2.emit_league_event(
      p_league_id, 'WAIVER_PROCESSED',
      jsonb_build_object(
        'league_id',  p_league_id,
        'week',       v_week,
        'season',     v_season,
        'considered', v_considered,
        'evaluated',  v_evaluated,
        'awarded',    v_awarded,
        'failed',     jsonb_array_length(v_failures),
        'total_faab_spent', v_spent,
        'claims',     v_claims,
        'failures',   v_failures),
      'league', p_league_id::text, p_at, v_week, v_season, null);
  end if;

  return jsonb_build_array(jsonb_build_object(
    'league_id',  p_league_id,
    'week',       v_week,
    'considered', v_considered,
    'evaluated',  v_evaluated,
    'awarded',    v_awarded,
    'failed',     jsonb_array_length(v_failures),
    'claims',     v_claims,
    'failures',   v_failures));
end;
$$;

/*
 * The cron entrypoint. With no league id it processes every league that has a
 * pending bid; with one, only that league.
 *
 * `p_now` is injectable for the same reason `isPlayerLocked(player, …, now)`
 * takes a clock: the tests have to be able to stand at a chosen instant, and
 * the lock check inside processing has to read the same one.
 */
create or replace function public.fsnv2_process_waivers(
  p_league_id uuid default null,
  p_now       timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_at      timestamptz := coalesce(p_now, now());
  v_leagues uuid[];
  v_league  uuid;
  v_out     jsonb := '[]'::jsonb;
begin
  select array_agg(distinct b.league_id) into v_leagues
    from fsnv2.waiver_bids b
   where b.status = 'PENDING'
     and (p_league_id is null or b.league_id = p_league_id);

  foreach v_league in array coalesce(v_leagues, '{}'::uuid[]) loop
    v_out := v_out || fsnv2.process_league_waivers(v_league, v_at);
  end loop;

  return jsonb_build_object(
    'processed_at', v_at,
    'leagues',      v_out,
    'awarded',      coalesce((select sum((l ->> 'awarded')::integer)
                                from jsonb_array_elements(v_out) l), 0),
    'considered',   coalesce((select sum((l ->> 'considered')::integer)
                                from jsonb_array_elements(v_out) l), 0));
end;
$$;

/*
 * An immediate free-agent add — the waiver wire's counterpart once a player
 * has cleared it. No auction, no FAAB, no processing run: the roster changes
 * now, which is exactly why the lock from 0013 is checked here first. Dropping
 * a player whose game is already under way is the same exploit as benching
 * them at halftime.
 */
create or replace function public.fsnv2_claim_free_agent(
  p_league_id      uuid,
  p_team_id        integer,
  p_player_id      text,
  p_drop_player_id text default null,
  p_now            timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_draft  uuid;
  v_at     timestamptz := coalesce(p_now, now());
  v_season integer;
  v_week   integer;
  v_locked jsonb;
  v_move   jsonb;
  v_result jsonb;
begin
  perform fsnv2.require_team(p_league_id, p_team_id);
  v_draft  := fsnv2.require_draft(p_league_id);
  v_season := public.fsnv2_current_nfl_season(v_at);
  v_week   := public.fsnv2_current_nfl_week(v_at);

  perform 1 from fsnv2.drafts where id = v_draft for update;

  if fsnv2.player_owner(v_draft, p_player_id) is not null then
    raise exception '% is not a free agent',
      coalesce((select name from fsnv2.players where id = p_player_id), p_player_id)
      using errcode = 'P0001';
  end if;
  if p_drop_player_id is null
     and fsnv2.roster_size(v_draft, p_team_id) >= fsnv2.roster_capacity(p_league_id) then
    raise exception 'your roster is full — name a player to drop' using errcode = 'P0001';
  end if;

  v_locked := public.fsnv2_locked_players(
    array_remove(array[p_player_id, p_drop_player_id], null), v_at, v_season, v_week);
  if jsonb_array_length(v_locked) > 0 then
    raise exception 'Cannot move player: % is locked because their game has already started.',
      v_locked -> 0 ->> 'name' using errcode = 'P0001';
  end if;

  v_move := fsnv2.apply_roster_change(
    v_draft, p_team_id, p_player_id, p_drop_player_id, 'free_agency');

  v_result := jsonb_build_object(
    'league_id', p_league_id,
    'team_id',   p_team_id,
    'team_name', fsnv2.team_label(v_draft, p_team_id),
    'added',     fsnv2.player_card(p_player_id),
    'dropped',   fsnv2.player_card(p_drop_player_id),
    'slot',      v_move -> 'slot',
    'week',      v_week);

  perform fsnv2.emit_league_event(
    p_league_id, 'WAIVER_CLAIM_AWARDED',
    v_result || jsonb_build_object('source', 'free_agency', 'bid_amount', 0),
    'player', p_player_id, v_at, v_week, v_season,
    format('free-agency:%s:%s:%s', p_league_id, p_player_id, v_at::text));

  return v_result;
end;
$$;

-- =============================================================================
-- The trade engine
--
-- Three steps, three RPCs, because they are three different decisions:
--
--   propose   one manager offers; nothing moves, but the offer is checked
--             against both rosters so an impossible trade is never on the table
--   respond   the other manager accepts, rejects, or the proposer withdraws
--   execute   the swap itself, atomic, and guarded by the lineup lock
--
-- Separating accept from execute is what makes a commissioner veto window and
-- the deferred-execution path below possible: an ACCEPTED trade is an agreement,
-- and an EXECUTED one is a fact about the rosters.
-- =============================================================================

/* Everything about one trade, shaped for the UI and for the event payload. */
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
                                   then fsnv2.player_card(i.asset_id) end)
             order by i.sender_team_id, i.asset_type, i.asset_id)
        from fsnv2.trade_items i where i.trade_id = p_trade_id), '[]'::jsonb)
  );
end;
$$;

create or replace function public.fsnv2_trade(p_trade_id uuid)
returns jsonb language sql stable security definer set search_path = fsnv2, public as $$
  select fsnv2.trade_payload(p_trade_id);
$$;

/* A league's trade log, newest first; optionally one team's or one status's. */
create or replace function public.fsnv2_trades(
  p_league_id uuid,
  p_team_id   integer default null,
  p_status    text default null,
  p_limit     integer default 50
) returns jsonb
language sql stable security definer set search_path = fsnv2, public as $$
  select coalesce(jsonb_agg(fsnv2.trade_payload(t.id) order by t.created_at desc), '[]'::jsonb)
  from (
    select id, created_at from fsnv2.trades
     where league_id = p_league_id
       and (p_status is null or status = p_status)
       and (p_team_id is null
            or proposer_team_id = p_team_id or recipient_team_id = p_team_id)
     order by created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) t;
$$;

/*
 * Is this trade possible, right now?
 *
 * Called twice: once by `fsnv2_propose_trade`, so an impossible offer is never
 * inserted, and once by `fsnv2_execute_trade`, because a roster can change
 * between the handshake and the swap — a player in the trade can be traded
 * again, dropped, or claimed on waivers in between.
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

/*
 * ACCEPT / REJECT by the recipient, CANCEL by the proposer, VETO by the league.
 *
 * Accepting does not move anyone — `fsnv2_execute_trade` does. That is what
 * leaves room for a veto window, and it is what lets an accepted trade whose
 * players are mid-game wait for the week to turn instead of being refused.
 */
create or replace function public.fsnv2_respond_trade(
  p_trade_id uuid,
  p_team_id  integer,
  p_action   text,
  p_note     text default null
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_trade  fsnv2.trades;
  v_action text := upper(coalesce(p_action, ''));
  v_status text;
  v_event  text;
  v_draft  uuid;
begin
  select * into v_trade from fsnv2.trades where id = p_trade_id for update;
  if not found then
    raise exception 'trade % not found', p_trade_id using errcode = 'P0002';
  end if;
  v_draft := fsnv2.active_draft(v_trade.league_id);

  if v_trade.status <> 'PENDING' then
    raise exception 'this trade is %, so it cannot be %', lower(v_trade.status), lower(v_action)
      using errcode = 'P0001';
  end if;

  -- An offer nobody answered in time is withdrawn rather than silently
  -- accepted a week later.
  if v_trade.expires_at is not null and v_trade.expires_at <= now() then
    update fsnv2.trades
       set status = 'CANCELLED', status_detail = 'expired before it was answered',
           responded_at = now()
     where id = p_trade_id returning * into v_trade;
    perform fsnv2.emit_league_event(
      v_trade.league_id, 'TRADE_CANCELLED', fsnv2.trade_payload(p_trade_id),
      'trade', p_trade_id::text, now(), null, null,
      'trade-expired:' || p_trade_id::text, 'SKIPPED');
    raise exception 'this trade expired on %', v_trade.expires_at using errcode = 'P0001';
  end if;

  if v_action in ('ACCEPT', 'REJECT') then
    if p_team_id is distinct from v_trade.recipient_team_id then
      raise exception 'only % can answer this trade',
        fsnv2.team_label(v_draft, v_trade.recipient_team_id) using errcode = 'P0001';
    end if;
    v_status := case when v_action = 'ACCEPT' then 'ACCEPTED' else 'REJECTED' end;
    v_event  := case when v_action = 'ACCEPT' then 'TRADE_ACCEPTED' else 'TRADE_REJECTED' end;

  elsif v_action = 'CANCEL' then
    if p_team_id is distinct from v_trade.proposer_team_id then
      raise exception 'only % can withdraw this trade',
        fsnv2.team_label(v_draft, v_trade.proposer_team_id) using errcode = 'P0001';
    end if;
    v_status := 'CANCELLED';
    v_event  := 'TRADE_CANCELLED';

  elsif v_action = 'VETO' then
    -- A league action, not a franchise's, so there is no team to check against.
    -- Phase 1 has no auth; what keeps this out of a browser's reach is that the
    -- whole function is granted to service_role only (see the grants at the foot
    -- of this file) and answered through /api/trades/respond, where the request
    -- can be attributed.
    v_status := 'VETOED';
    v_event  := 'TRADE_VETOED';

  else
    raise exception 'unknown action "%" — expected ACCEPT, REJECT, CANCEL or VETO', p_action
      using errcode = 'P0001';
  end if;

  update fsnv2.trades
     set status = v_status, status_detail = p_note, responded_at = now()
   where id = p_trade_id returning * into v_trade;

  -- An accepted trade is news as soon as it is agreed; the Trade Breakdown
  -- itself waits for the swap, which is the event the pipeline writes from.
  perform fsnv2.emit_league_event(
    v_trade.league_id, v_event, fsnv2.trade_payload(p_trade_id),
    'trade', p_trade_id::text, now(), null, null,
    format('%s:%s', lower(v_event), p_trade_id),
    case when v_event = 'TRADE_ACCEPTED' then 'PENDING' else 'SKIPPED' end);

  return fsnv2.trade_payload(p_trade_id);
end;
$$;

/*
 * Which players in this trade are already playing?
 *
 * The same report `fsnv2_locked_players` gives the lineup swap, narrowed to one
 * trade's PLAYER assets. /api/trades/execute calls this first so a deferral is
 * explainable before anything is attempted, and `fsnv2_execute_trade` calls it
 * again inside the write — the two-layer guard 0013 established, for the same
 * reason: a kickoff can land between the check and the swap.
 */
create or replace function public.fsnv2_trade_lock_report(
  p_trade_id uuid,
  p_now      timestamptz default now()
) returns jsonb
language plpgsql stable security definer set search_path = fsnv2, public as $$
declare
  v_at  timestamptz := coalesce(p_now, now());
  v_ids text[];
begin
  select array_agg(i.asset_id) into v_ids
    from fsnv2.trade_items i
   where i.trade_id = p_trade_id and i.asset_type = 'PLAYER';

  return public.fsnv2_locked_players(
    coalesce(v_ids, '{}'::text[]), v_at,
    public.fsnv2_current_nfl_season(v_at),
    public.fsnv2_current_nfl_week(v_at));
end;
$$;

-- =============================================================================
-- The atomic swap — requirement 3.
--
-- Every player moves, every dollar moves, or nothing does. The guard is the
-- one from 0013, re-run here over the whole trade payload rather than two
-- players: if any player in the trade is in a game that has already started,
-- the trade is not refused and not half-applied — it is marked
-- PENDING_NEXT_WEEK and swept up by `fsnv2_process_pending_trades` once the
-- week turns.
--
-- Deferring rather than refusing matters. A manager who agrees a trade on
-- Sunday afternoon has agreed to it; telling them "no, and start again" loses
-- a deal that both sides wanted, while applying it mid-game would hand one of
-- them points that were already on the board. Neither is the answer, so the
-- trade waits.
--
-- Players are released from both rosters before either acquisition is written.
-- Swapping them one at a time would push a full roster one player over the
-- limit halfway through the trade, and the lineup patch would start shuffling
-- slots to absorb a player the other side is about to take back.
-- =============================================================================
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

  -- A traded draft pick is recorded and reported, not transferred: this schema
  -- has no pick ledger to move it in (fsnv2.draft_picks is a record of picks
  -- *made*, not of future selections). The item and this event are the
  -- commissioner's paper trail until one exists.
  for v_item in
    select i.* from fsnv2.trade_items i
     where i.trade_id = p_trade_id and i.asset_type = 'DRAFT_PICK'
  loop
    v_to := case when v_item.sender_team_id = v_trade.proposer_team_id
              then v_trade.recipient_team_id else v_trade.proposer_team_id end;
    v_moves := v_moves || jsonb_build_array(jsonb_build_object(
      'asset_type', 'DRAFT_PICK', 'asset_id', v_item.asset_id,
      'from_team_id', v_item.sender_team_id, 'to_team_id', v_to,
      'note', 'recorded only — no draft-pick ledger in this schema yet'));
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

/*
 * The deferred-trade sweep. Runs alongside waiver processing: every trade that
 * was mid-game when it was accepted gets its swap as soon as the week it was
 * deferred into has arrived.
 *
 * A trade whose players are *still* locked is re-deferred rather than forced —
 * the event's dedupe key carries the week, so a re-deferral files one event per
 * week rather than one per sweep.
 */
create or replace function public.fsnv2_process_pending_trades(
  p_league_id uuid default null,
  p_now       timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_at    timestamptz := coalesce(p_now, now());
  v_week  integer := public.fsnv2_current_nfl_week(v_at);
  v_trade record;
  v_out   jsonb := '[]'::jsonb;
  v_one   jsonb;
begin
  for v_trade in
    select t.id from fsnv2.trades t
     where t.status = 'PENDING_NEXT_WEEK'
       and (p_league_id is null or t.league_id = p_league_id)
       and coalesce(t.effective_week, 0) <= v_week
     order by t.created_at
  loop
    v_one := public.fsnv2_execute_trade(v_trade.id, v_at);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'trade_id', v_trade.id,
      'status',   v_one ->> 'status',
      'detail',   v_one ->> 'status_detail'));
  end loop;

  return jsonb_build_object('week', v_week, 'swept', v_out);
end;
$$;

/* Housekeeping: offers nobody answered. Called by the same cron worker. */
create or replace function public.fsnv2_expire_trades(
  p_league_id uuid default null,
  p_now       timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = fsnv2, public as $$
declare
  v_at  timestamptz := coalesce(p_now, now());
  v_row record;
  v_out jsonb := '[]'::jsonb;
begin
  for v_row in
    update fsnv2.trades
       set status = 'CANCELLED', status_detail = 'expired before it was answered',
           responded_at = v_at
     where status = 'PENDING'
       and expires_at is not null and expires_at <= v_at
       and (p_league_id is null or league_id = p_league_id)
    returning id, league_id
  loop
    perform fsnv2.emit_league_event(
      v_row.league_id, 'TRADE_CANCELLED', fsnv2.trade_payload(v_row.id),
      'trade', v_row.id::text, v_at, null, null,
      'trade-expired:' || v_row.id::text, 'SKIPPED');
    v_out := v_out || jsonb_build_array(to_jsonb(v_row.id));
  end loop;

  return jsonb_build_object('expired', v_out);
end;
$$;

-- =============================================================================
-- Grants
--
-- The line is drawn at who the action belongs to, not at reads versus writes.
--
--   anon / authenticated   what a manager does with their own franchise: look
--                          at the wire, bid, withdraw a bid, sign a free agent.
--                          Phase 1 has no auth (see the note in 0002), so these
--                          are the same grants the lineup swap carries.
--   service_role only      anything that moves another team's roster or the
--                          league's: processing the wire, proposing and
--                          answering trades, the swap itself, a veto, the
--                          event queue. Every one of those is reached through
--                          an API route holding the service key, which is where
--                          the request can be attributed and rate-limited —
--                          and it is what keeps a browser from vetoing a trade
--                          it is not party to.
--
-- The fsnv2.* helpers are granted to nobody: they are only ever called from
-- inside these security-definer functions.
-- =============================================================================

grant execute on function
  public.fsnv2_free_agents(uuid, text, integer, text),
  public.fsnv2_waiver_state(uuid),
  public.fsnv2_waiver_board(uuid),
  public.fsnv2_submit_waiver_bid(uuid, integer, text, text, numeric, integer),
  public.fsnv2_cancel_waiver_bid(uuid, integer),
  public.fsnv2_claim_free_agent(uuid, integer, text, text, timestamptz),
  public.fsnv2_trade(uuid),
  public.fsnv2_trades(uuid, integer, text, integer),
  public.fsnv2_trade_lock_report(uuid, timestamptz),
  public.fsnv2_league_feed(uuid, timestamptz, integer, text[])
to anon, authenticated, service_role;

grant execute on function
  public.fsnv2_process_waivers(uuid, timestamptz),
  public.fsnv2_reset_waiver_priority(uuid),
  public.fsnv2_propose_trade(uuid, integer, integer, jsonb, timestamptz, text),
  public.fsnv2_respond_trade(uuid, integer, text, text),
  public.fsnv2_execute_trade(uuid, timestamptz),
  public.fsnv2_process_pending_trades(uuid, timestamptz),
  public.fsnv2_expire_trades(uuid, timestamptz),
  public.fsnv2_claim_league_events(integer, uuid),
  public.fsnv2_complete_league_event(uuid, boolean, text)
to service_role;

-- Same reason as 0008 and 0013: PostgREST answers from a cached copy of the
-- catalog, so a freshly created function is invisible until it refreshes.
-- Asking for the refresh here means applying the migration is enough.
notify pgrst, 'reload schema';
