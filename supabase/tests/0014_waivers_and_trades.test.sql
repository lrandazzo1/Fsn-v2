-- =============================================================================
-- Regression harness for migration 0014 — the waiver wire and the trade engine.
--
-- Everything 0014 does happens inside Postgres, in one transaction, and most of
-- it is only reachable with a drafted league and a synced NFL week in front of
-- it. So it is tested the same way: against a real database, with a real
-- league, by the RPCs the API routes actually call.
--
--   createdb fsn
--   psql -d fsn -c 'create role anon; create role authenticated; create role service_role;'
--   for f in supabase/migrations/0*.sql; do psql -v ON_ERROR_STOP=1 -d fsn -f "$f"; done
--   psql -v ON_ERROR_STOP=1 -d fsn -f supabase/tests/0014_waivers_and_trades.test.sql
--
-- The whole run is one transaction and ends in a rollback, so it can be pointed
-- at a scratch copy of a real database without leaving anything behind. It
-- prints one line per case and raises on the first failure.
--
-- The JavaScript half of this — that `sortWaiverBids()` in js/transactions.js
-- puts bids in the same order `fsnv2_waiver_board` does — is in
-- tests/transactions.test.mjs, which needs no database.
-- =============================================================================
\set ON_ERROR_STOP on
set client_min_messages = warning;
begin;

create or replace function pg_temp.ok(p_name text, p_condition boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  if p_condition then
    raise notice '  ok   %', p_name;
  else
    raise exception 'FAILED: % %', p_name, coalesce('— ' || p_detail, '')
      using errcode = 'P0001';
  end if;
end;
$$;
set client_min_messages = notice;

-- ----------------------------------------------------------------- fixtures --
-- A four-team league, drafted three rounds deep, and a week-3 slate in which
-- Green Bay and Minnesota have already played.
create temporary table ids (league uuid, draft uuid);
insert into ids values (gen_random_uuid(), gen_random_uuid());

insert into fsnv2.leagues (id, name, total_teams, roster_settings, waiver_settings)
select league, 'Harness League', 4,
  jsonb_build_object('starters', jsonb_build_object('QB',1,'RB',2,'WR',2,'TE',1,'FLEX',1,'DST',1,'K',1),
                     'bench', 6, 'flex_positions', jsonb_build_array('RB','WR','TE')),
  jsonb_build_object('mode','faab','budget',100,'min_bid',0,'tiebreak','rolling')
from ids;

insert into fsnv2.drafts (id, league_id, rounds, status, teams)
select draft, league, 3, 'complete',
  jsonb_build_array(
    jsonb_build_object('slot',1,'name','Alpha','abbr','ALP','is_user',true),
    jsonb_build_object('slot',2,'name','Bravo','abbr','BRV','is_user',false),
    jsonb_build_object('slot',3,'name','Charlie','abbr','CHR','is_user',false),
    jsonb_build_object('slot',4,'name','Delta','abbr','DLT','is_user',false))
from ids;

insert into fsnv2.players (id, name, position, team, adp) values
  ('h-01','Pat Mahomes','QB','KC',1),   ('h-02','Bijan Robinson','RB','ATL',2),
  ('h-03','Ja''Marr Chase','WR','CIN',3), ('h-04','Josh Allen','QB','BUF',4),
  ('h-05','Saquon Barkley','RB','PHI',5), ('h-06','Justin Jefferson','WR','MIN',6),
  ('h-07','Jalen Hurts','QB','PHI',7),   ('h-08','Jahmyr Gibbs','RB','DET',8),
  ('h-09','Amon-Ra St. Brown','WR','DET',9), ('h-10','Jordan Love','QB','GB',10),
  ('h-11','Josh Jacobs','RB','GB',11),   ('h-12','Garrett Wilson','WR','NYJ',12),
  ('hfa-rb','Rico Dowdle','RB','CAR',40), ('hfa-wr','Jauan Jennings','WR','SF',41),
  ('hfa-te','Cade Otton','TE','TB',42),   ('hfa-qb','Sam Darnold','QB','SEA',43),
  -- A free agent whose NFL team has already played this week.
  ('hfa-gb','Dontayvion Wicks','WR','GB',44)
on conflict (id) do nothing;

-- Snake order over four teams, three rounds: team 1 gets h-01, h-08, h-09.
insert into fsnv2.draft_picks (draft_id, pick_number, round, team_id, player_id, source)
select draft, n, ((n - 1) / 4) + 1, public.fsnv2_snake_team(n, 4, 'snake'),
       format('h-%s', lpad(n::text, 2, '0')), 'manual'
  from ids, generate_series(1, 12) n;

-- Week 3 of 2026: GB at MIN is final, so Jordan Love, Josh Jacobs and Justin
-- Jefferson are locked. The rest of the slate has not kicked off.
insert into fsnv2.nfl_matchups (provider, external_id, season, week, season_type,
                                home_team, away_team, kickoff, status)
values
  ('harness','w3_GB@MIN', 2026, 3, 'reg', 'MIN', 'GB',  '2026-09-24T17:00:00Z', 'final'),
  ('harness','w3_KC@PHI', 2026, 3, 'reg', 'PHI', 'KC',  '2026-12-31T17:00:00Z', 'scheduled'),
  ('harness','w3_CAR@SF', 2026, 3, 'reg', 'SF',  'CAR', '2026-12-31T17:00:00Z', 'scheduled'),
  ('harness','w3_DET@CIN',2026, 3, 'reg', 'CIN', 'DET', '2026-12-31T17:00:00Z', 'scheduled'),
  ('harness','w3_ATL@TB', 2026, 3, 'reg', 'TB',  'ATL', '2026-12-31T17:00:00Z', 'scheduled'),
  ('harness','w3_NYJ@BUF',2026, 3, 'reg', 'BUF', 'NYJ', '2026-12-31T17:00:00Z', 'scheduled'),
  ('harness','w3_SEA@LAR',2026, 3, 'reg', 'LAR', 'SEA', '2026-12-31T17:00:00Z', 'scheduled')
on conflict (provider, external_id) do nothing;

-- Mid-week-3, with Thursday night already played.
\set NOW '2026-09-26T12:00:00Z'

-- psql does not interpolate into dollar-quoted bodies, so the clock the cases
-- stand at is a function rather than a \set.
create or replace function pg_temp.at() returns timestamptz
language sql immutable as $$ select '2026-09-26T12:00:00Z'::timestamptz $$;
create or replace function pg_temp.league() returns uuid
language sql stable as $$ select league from ids limit 1 $$;
create or replace function pg_temp.draft() returns uuid
language sql stable as $$ select draft from ids limit 1 $$;

/*
 * Back to the state the draft left: the twelve drafted players on their
 * original rosters, no claims, no lineups, full budgets, waiver order 1..4.
 * Cases that depend on a roster call this first so the file can be read — and
 * re-ordered — one section at a time.
 */
create or replace function pg_temp.reset_league() returns void
language plpgsql as $$
begin
  delete from fsnv2.waiver_bids where league_id = pg_temp.league();
  delete from fsnv2.trade_items where trade_id in
    (select id from fsnv2.trades where league_id = pg_temp.league());
  delete from fsnv2.trades where league_id = pg_temp.league();
  delete from fsnv2.lineups where draft_id = pg_temp.draft();
  delete from fsnv2.draft_picks where draft_id = pg_temp.draft();

  insert into fsnv2.draft_picks (draft_id, pick_number, round, team_id, player_id, source)
  select pg_temp.draft(), n, ((n - 1) / 4) + 1, public.fsnv2_snake_team(n, 4, 'snake'),
         format('h-%s', lpad(n::text, 2, '0')), 'manual'
    from generate_series(1, 12) n;

  insert into fsnv2.team_waiver_state (league_id, team_id, faab_balance, waiver_priority)
  select pg_temp.league(), slot, 100, slot from generate_series(1, 4) slot
  on conflict (league_id, team_id)
    do update set faab_balance = 100, waiver_priority = excluded.waiver_priority,
                  claims_won = 0;
end;
$$;

-- =============================================================================
\echo '— the calendar and the lock mirror (0013)'
-- =============================================================================
do $$
begin
  perform pg_temp.ok('the clock lands in week 3',
    public.fsnv2_current_nfl_week(pg_temp.at()) = 3,
    'got ' || public.fsnv2_current_nfl_week(pg_temp.at()));
  perform pg_temp.ok('a final game locks its teams',
    public.fsnv2_player_locked('GB', 2026, 3, pg_temp.at()));
  perform pg_temp.ok('a scheduled game does not',
    not public.fsnv2_player_locked('KC', 2026, 3, pg_temp.at()));
  perform pg_temp.ok('a team with no game this week is never locked',
    not public.fsnv2_player_locked('NE', 2026, 3, pg_temp.at()));
end $$;

-- =============================================================================
\echo '— free agency'
-- =============================================================================
do $$
declare v_pool jsonb;
begin
  v_pool := public.fsnv2_free_agents(pg_temp.league(), null, 500);
  perform pg_temp.ok('every undrafted player is in the free-agent pool',
    (select count(*) from jsonb_array_elements(v_pool) p
      where p ->> 'player_id' like 'hfa-%') = 5);
  perform pg_temp.ok('no rostered player appears in it',
    not exists (select 1 from jsonb_array_elements(v_pool) p
                 where p ->> 'player_id' like 'h-0%' or p ->> 'player_id' like 'h-1%'));
  perform pg_temp.ok('the pool filters by position',
    (select bool_and(p ->> 'position' = 'TE')
       from jsonb_array_elements(public.fsnv2_free_agents(pg_temp.league(), 'TE', 500)) p));
end $$;

-- =============================================================================
\echo '— submitting a bid'
-- =============================================================================
do $$
declare v_bid jsonb;
begin
  perform pg_temp.reset_league();
  v_bid := public.fsnv2_submit_waiver_bid(pg_temp.league(), 1, 'hfa-rb', 'h-09', 10);
  perform pg_temp.ok('a bid lands PENDING', v_bid ->> 'status' = 'PENDING');
  perform pg_temp.ok('and at the back of the team''s own board',
    (v_bid ->> 'priority')::integer = 1);

  -- A second bid on the same player replaces the first rather than stacking.
  v_bid := public.fsnv2_submit_waiver_bid(pg_temp.league(), 1, 'hfa-rb', 'h-09', 12);
  perform pg_temp.ok('re-bidding on the same player replaces the bid',
    (select count(*) from fsnv2.waiver_bids
      where league_id = pg_temp.league() and team_id = 1 and player_id = 'hfa-rb'
        and status = 'PENDING') = 1);
  perform pg_temp.ok('at the new price', (v_bid ->> 'bid_amount')::numeric = 12);

  begin
    perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 1, 'h-04', null, 5);
    perform pg_temp.ok('a bid on a rostered player is refused', false);
  exception when others then
    perform pg_temp.ok('a bid on a rostered player is refused', sqlerrm like '%already on%');
  end;

  begin
    perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 1, 'hfa-wr', 'h-04', 5);
    perform pg_temp.ok('dropping another team''s player is refused', false);
  exception when others then
    perform pg_temp.ok('dropping another team''s player is refused',
      sqlerrm like '%not on your roster%');
  end;

  begin
    perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 1, 'hfa-wr', null, 500);
    perform pg_temp.ok('a bid over the FAAB budget is refused', false);
  exception when others then
    perform pg_temp.ok('a bid over the FAAB budget is refused',
      sqlerrm like '%exceeds your remaining FAAB%');
  end;

  perform public.fsnv2_cancel_waiver_bid(
    (select id from fsnv2.waiver_bids
      where league_id = pg_temp.league() and team_id = 1 and player_id = 'hfa-rb'), 1);
  perform pg_temp.ok('a cancelled bid leaves no pending row',
    (select count(*) from fsnv2.waiver_bids
      where league_id = pg_temp.league() and status = 'PENDING') = 0);
end $$;

-- =============================================================================
\echo '— the processing order: money, then the rolling list, then the clock'
-- =============================================================================
do $$
declare v_board jsonb;
begin
  perform pg_temp.reset_league();
  -- Teams 1 and 2 tie at $10; team 3 outbids both; team 4 bids least.
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 2, 'hfa-rb', null, 10);
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 1, 'hfa-rb', null, 10);
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 3, 'hfa-rb', null, 25);
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 4, 'hfa-rb', null, 1);

  v_board := public.fsnv2_waiver_board(pg_temp.league());
  perform pg_temp.ok('the highest bid is walked first',
    (v_board -> 0 ->> 'team_id')::integer = 3);
  -- Team 1 bid *after* team 2 but holds waiver priority 1, so it comes first:
  -- the league order breaks a tie on money before the clock does.
  perform pg_temp.ok('a tie on money is broken by waiver priority, not by time',
    (v_board -> 1 ->> 'team_id')::integer = 1 and (v_board -> 2 ->> 'team_id')::integer = 2);
  perform pg_temp.ok('the lowest bid is walked last',
    (v_board -> 3 ->> 'team_id')::integer = 4);
end $$;

-- =============================================================================
\echo '— processing: one winner, the money moves, everyone else is told why'
-- =============================================================================
do $$
declare v_run jsonb; v_league jsonb;
begin
  v_run := public.fsnv2_process_waivers(pg_temp.league(), pg_temp.at());
  v_league := v_run -> 'leagues' -> 0;

  perform pg_temp.ok('four bids were considered',
    (v_league ->> 'considered')::integer = 4, v_league ->> 'considered');
  perform pg_temp.ok('one was awarded', (v_league ->> 'awarded')::integer = 1);
  perform pg_temp.ok('the other three failed', (v_league ->> 'failed')::integer = 3);

  perform pg_temp.ok('the winner holds the player',
    fsnv2.player_owner(pg_temp.draft(), 'hfa-rb') = 3);
  perform pg_temp.ok('the winner paid the bid, not the runner-up''s price',
    (select faab_balance from fsnv2.team_waiver_state
      where league_id = pg_temp.league() and team_id = 3) = 75);
  perform pg_temp.ok('nobody else was charged',
    (select count(*) from fsnv2.team_waiver_state
      where league_id = pg_temp.league() and team_id <> 3 and faab_balance <> 100) = 0);
  perform pg_temp.ok('the losers are FAILED_PLAYER_TAKEN, not left pending',
    (select count(*) from fsnv2.waiver_bids
      where league_id = pg_temp.league() and status = 'FAILED_PLAYER_TAKEN') = 3);
  perform pg_temp.ok('and each one says who took the player',
    (select bool_and(result_detail like '%awarded to Charlie%') from fsnv2.waiver_bids
      where league_id = pg_temp.league() and status = 'FAILED_PLAYER_TAKEN'));
  perform pg_temp.ok('the claim is a draft_picks row with source = waiver',
    (select source from fsnv2.draft_picks
      where draft_id = pg_temp.draft() and player_id = 'hfa-rb') = 'waiver');
  perform pg_temp.ok('numbered above the draft''s own picks, so it cannot collide',
    (select pick_number from fsnv2.draft_picks
      where draft_id = pg_temp.draft() and player_id = 'hfa-rb') > 12);
  perform pg_temp.ok('the winner drops to the back of the waiver list',
    (select waiver_priority from fsnv2.team_waiver_state
      where league_id = pg_temp.league() and team_id = 3) = 4);
  perform pg_temp.ok('and the list is still 1..4 with no gaps',
    (select count(distinct waiver_priority) from fsnv2.team_waiver_state
      where league_id = pg_temp.league()) = 4);
  perform pg_temp.ok('nothing is left pending',
    (select count(*) from fsnv2.waiver_bids
      where league_id = pg_temp.league() and status = 'PENDING') = 0);
end $$;

-- =============================================================================
\echo '— the cascade: a drop can only be spent once, a budget only once'
-- =============================================================================
do $$
declare v_run jsonb;
begin
  perform pg_temp.reset_league();

  -- Team 1 wants two players and names the same man to drop for both. Only the
  -- first claim can have him; the second has nowhere to put the player.
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 1, 'hfa-wr', 'h-09', 20);
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 1, 'hfa-te', 'h-09', 5);
  -- And team 2 bids more than it can afford once its first claim is paid for.
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 2, 'hfa-qb', null, 60);

  v_run := public.fsnv2_process_waivers(pg_temp.league(), pg_temp.at());

  perform pg_temp.ok('the team''s first-choice claim is awarded',
    (select status from fsnv2.waiver_bids
      where league_id = pg_temp.league() and player_id = 'hfa-wr') = 'SUCCESSFUL');
  perform pg_temp.ok('the claim that depended on the same drop is invalidated',
    (select status from fsnv2.waiver_bids
      where league_id = pg_temp.league() and player_id = 'hfa-te') = 'FAILED_PLAYER_TAKEN');
  perform pg_temp.ok('and it says the drop was already spent',
    (select result_detail from fsnv2.waiver_bids
      where league_id = pg_temp.league() and player_id = 'hfa-te')
      like '%already dropped for the winning claim%');
  perform pg_temp.ok('the dropped player is a free agent again',
    fsnv2.player_owner(pg_temp.draft(), 'h-09') is null);
  perform pg_temp.ok('and shows up in the pool',
    exists (select 1 from jsonb_array_elements(
      public.fsnv2_free_agents(pg_temp.league(), null, 500)) p
      where p ->> 'player_id' = 'h-09'));
  perform pg_temp.ok('the roster is the same size it was',
    fsnv2.roster_size(pg_temp.draft(), 1) = 3);
end $$;

do $$
declare v_run jsonb;
begin
  perform pg_temp.reset_league();
  update fsnv2.team_waiver_state set faab_balance = 60
   where league_id = pg_temp.league() and team_id = 2;

  -- Two claims, $40 each, against a $60 budget: the first is paid, the second
  -- is checked against what is left rather than against the opening balance.
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 2, 'hfa-rb', null, 40);
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 2, 'hfa-wr', null, 40);
  v_run := public.fsnv2_process_waivers(pg_temp.league(), pg_temp.at());

  perform pg_temp.ok('one of the two claims is paid for',
    (select count(*) from fsnv2.waiver_bids
      where league_id = pg_temp.league() and team_id = 2 and status = 'SUCCESSFUL') = 1);
  perform pg_temp.ok('the second is FAILED_INSUFFICIENT_FAAB',
    (select count(*) from fsnv2.waiver_bids
      where league_id = pg_temp.league() and team_id = 2
        and status = 'FAILED_INSUFFICIENT_FAAB') = 1);
  perform pg_temp.ok('the budget cannot go negative',
    (select faab_balance from fsnv2.team_waiver_state
      where league_id = pg_temp.league() and team_id = 2) = 20);
end $$;

-- =============================================================================
\echo '— the lock, on the way out: a locked player cannot be dropped'
-- =============================================================================
do $$
begin
  perform pg_temp.reset_league();

  -- h-11 is Josh Jacobs, whose Green Bay game is already final. Team 3 holds
  -- him and offers him up to make room for a free agent.
  perform pg_temp.ok('the drop target is on the bidding team',
    fsnv2.player_owner(pg_temp.draft(), 'h-11') = 3);
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 3, 'hfa-rb', 'h-11', 30);
  perform public.fsnv2_process_waivers(pg_temp.league(), pg_temp.at());

  perform pg_temp.ok('the claim is refused rather than moving a player mid-game',
    (select status from fsnv2.waiver_bids
      where league_id = pg_temp.league() and player_id = 'hfa-rb') = 'FAILED_PLAYER_TAKEN');
  perform pg_temp.ok('with 0013''s wording',
    (select result_detail from fsnv2.waiver_bids
      where league_id = pg_temp.league() and player_id = 'hfa-rb')
      like '%locked because their game has already started%');
  perform pg_temp.ok('the locked player is still on the roster',
    fsnv2.player_owner(pg_temp.draft(), 'h-11') = 3);
  perform pg_temp.ok('and no money moved',
    (select faab_balance from fsnv2.team_waiver_state
      where league_id = pg_temp.league() and team_id = 3) = 100);
end $$;

-- =============================================================================
\echo '— the lineup follows the roster'
-- =============================================================================
do $$
declare v_state jsonb; v_roster jsonb;
begin
  perform pg_temp.reset_league();
  -- Team 1 is the user's team, so it has a saved lineup.
  v_state  := public.fsnv2_lineup_state(pg_temp.draft(), 1);
  insert into fsnv2.lineups (draft_id, team_id, roster, version)
  values (pg_temp.draft(), 1, v_state -> 'roster', 0)
  on conflict (draft_id, team_id) do update set roster = excluded.roster;

  perform pg_temp.ok('the WR slot holds the player about to be dropped',
    v_state -> 'roster' ->> 'WR1' = 'h-09', v_state -> 'roster' ->> 'WR1');

  -- Swap a WR for a WR: the new player should take the slot that just opened.
  perform public.fsnv2_claim_free_agent(pg_temp.league(), 1, 'hfa-wr', 'h-09', pg_temp.at());
  select roster into v_roster from fsnv2.lineups
   where draft_id = pg_temp.draft() and team_id = 1;

  perform pg_temp.ok('the new player takes the dropped player''s slot',
    v_roster ->> 'WR1' = 'hfa-wr', v_roster ->> 'WR1');
  perform pg_temp.ok('the dropped player is nowhere in the lineup',
    not exists (select 1 from jsonb_each_text(v_roster) r where r.value = 'h-09'));
  perform pg_temp.ok('the version is bumped, so a stale tab is rejected',
    (select version from fsnv2.lineups
      where draft_id = pg_temp.draft() and team_id = 1) = 1);

  -- A position that cannot play the open slot lands on the bench instead.
  perform public.fsnv2_claim_free_agent(pg_temp.league(), 1, 'hfa-te', null, pg_temp.at());
  select roster into v_roster from fsnv2.lineups
   where draft_id = pg_temp.draft() and team_id = 1;
  perform pg_temp.ok('an added player with no starter hole goes to the bench',
    v_roster ->> 'BN1' = 'hfa-te', coalesce(v_roster ->> 'BN1', 'null'));
  perform pg_temp.ok('the lineup still holds exactly the roster',
    (select count(*) from fsnv2.draft_picks
      where draft_id = pg_temp.draft() and team_id = 1)
    = (select count(*) from jsonb_each_text(v_roster) r where r.value is not null));
end $$;

do $$
begin
  perform pg_temp.reset_league();
  perform pg_temp.ok('hfa-gb is an unrostered Packer',
    fsnv2.player_owner(pg_temp.draft(), 'hfa-gb') is null
    and (select team from fsnv2.players where id = 'hfa-gb') = 'GB');
  begin
    perform public.fsnv2_claim_free_agent(pg_temp.league(), 2, 'hfa-gb', null, pg_temp.at());
    perform pg_temp.ok('signing a player whose game has started is refused', false);
  exception when others then
    perform pg_temp.ok('signing a player whose game has started is refused',
      sqlerrm like '%locked because their game has already started%', sqlerrm);
  end;
  perform pg_temp.ok('and nothing was added',
    fsnv2.player_owner(pg_temp.draft(), 'hfa-gb') is null);
end $$;

-- =============================================================================
\echo '— proposing a trade'
-- =============================================================================
do $$
declare v_trade jsonb;
begin
  perform pg_temp.reset_league();

  -- Team 1's Jahmyr Gibbs (h-08) for team 2's Jalen Hurts (h-07), plus $5.
  v_trade := public.fsnv2_propose_trade(pg_temp.league(), 1, 2, jsonb_build_array(
    jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'h-08'),
    jsonb_build_object('sender_team_id', 2, 'asset_type', 'PLAYER', 'asset_id', 'h-07'),
    jsonb_build_object('sender_team_id', 2, 'asset_type', 'FAAB',   'amount', 5)));

  perform pg_temp.ok('the trade opens PENDING', v_trade ->> 'status' = 'PENDING');
  perform pg_temp.ok('with a default expiry 48 hours out',
    (v_trade ->> 'expires_at')::timestamptz > now() + interval '47 hours');
  perform pg_temp.ok('and three items', jsonb_array_length(v_trade -> 'items') = 3);
  perform pg_temp.ok('each one naming its receiver',
    (select bool_and((i ->> 'receiver_team_id')::integer in (1, 2))
       from jsonb_array_elements(v_trade -> 'items') i));
  perform pg_temp.ok('the players are named for the Trade Breakdown',
    (select bool_and(i -> 'player' ->> 'name' is not null)
       from jsonb_array_elements(v_trade -> 'items') i
      where i ->> 'asset_type' = 'PLAYER'));
  perform pg_temp.ok('nothing has moved yet',
    fsnv2.player_owner(pg_temp.draft(), 'h-08') = 1
    and fsnv2.player_owner(pg_temp.draft(), 'h-07') = 2);

  begin
    perform public.fsnv2_propose_trade(pg_temp.league(), 1, 2, jsonb_build_array(
      jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'h-07')));
    perform pg_temp.ok('offering a player you do not own is refused', false);
  exception when others then
    perform pg_temp.ok('offering a player you do not own is refused',
      sqlerrm like '%is not on%roster%', sqlerrm);
  end;

  begin
    perform public.fsnv2_propose_trade(pg_temp.league(), 1, 2, jsonb_build_array(
      jsonb_build_object('sender_team_id', 2, 'asset_type', 'FAAB', 'amount', 500)));
    perform pg_temp.ok('sending FAAB you do not have is refused', false);
  exception when others then
    perform pg_temp.ok('sending FAAB you do not have is refused',
      sqlerrm like '%cannot send%', sqlerrm);
  end;

  begin
    perform public.fsnv2_propose_trade(pg_temp.league(), 1, 1, jsonb_build_array(
      jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'h-08')));
    perform pg_temp.ok('trading with yourself is refused', false);
  exception when others then
    perform pg_temp.ok('trading with yourself is refused', sqlerrm like '%with itself%');
  end;

  begin
    perform public.fsnv2_propose_trade(pg_temp.league(), 1, 2, '[]'::jsonb);
    perform pg_temp.ok('an empty trade is refused', false);
  exception when others then
    perform pg_temp.ok('an empty trade is refused', sqlerrm like '%at least one asset%');
  end;

  perform pg_temp.ok('a refused proposal leaves no trade behind',
    (select count(*) from fsnv2.trades where league_id = pg_temp.league()) = 1);
end $$;

-- A roster that is already full cannot take on a player for nothing.
do $$
declare v_filled integer;
begin
  perform pg_temp.reset_league();
  -- Fill team 1 to the 15-player limit with free agents and spare players.
  insert into fsnv2.players (id, name, position, team, adp)
  select format('bulk-%s', n), format('Bulk Player %s', n), 'WR', 'LV', 300 + n
    from generate_series(1, 12) n
  on conflict (id) do nothing;
  for v_filled in 1 .. 12 loop
    exit when fsnv2.roster_size(pg_temp.draft(), 1) >= 15;
    perform fsnv2.apply_roster_change(
      pg_temp.draft(), 1, format('bulk-%s', v_filled), null, 'free_agency');
  end loop;
  perform pg_temp.ok('team 1 is at the roster limit',
    fsnv2.roster_size(pg_temp.draft(), 1) = 15);

  begin
    perform public.fsnv2_propose_trade(pg_temp.league(), 2, 1, jsonb_build_array(
      jsonb_build_object('sender_team_id', 2, 'asset_type', 'PLAYER', 'asset_id', 'h-07')));
    perform pg_temp.ok('a trade that overfills a roster is refused', false);
  exception when others then
    perform pg_temp.ok('a trade that overfills a roster is refused',
      sqlerrm like '%over this league%limit%', sqlerrm);
  end;

  -- The same trade with a player going the other way fits exactly.
  perform pg_temp.ok('an even swap is allowed at the limit',
    public.fsnv2_propose_trade(pg_temp.league(), 2, 1, jsonb_build_array(
      jsonb_build_object('sender_team_id', 2, 'asset_type', 'PLAYER', 'asset_id', 'h-07'),
      jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'bulk-1')))
    ->> 'status' = 'PENDING');
end $$;

-- =============================================================================
\echo '— answering a trade'
-- =============================================================================
do $$
declare v_trade jsonb; v_id uuid;
begin
  perform pg_temp.reset_league();
  v_trade := public.fsnv2_propose_trade(pg_temp.league(), 1, 2, jsonb_build_array(
    jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'h-08'),
    jsonb_build_object('sender_team_id', 2, 'asset_type', 'PLAYER', 'asset_id', 'h-07')));
  v_id := (v_trade ->> 'trade_id')::uuid;

  begin
    perform public.fsnv2_respond_trade(v_id, 1, 'ACCEPT');
    perform pg_temp.ok('the proposer cannot accept their own offer', false);
  exception when others then
    perform pg_temp.ok('the proposer cannot accept their own offer',
      sqlerrm like '%only%can answer%', sqlerrm);
  end;

  begin
    perform public.fsnv2_respond_trade(v_id, 3, 'ACCEPT');
    perform pg_temp.ok('a team outside the trade cannot accept it', false);
  exception when others then
    perform pg_temp.ok('a team outside the trade cannot accept it',
      sqlerrm like '%only%can answer%');
  end;

  begin
    perform public.fsnv2_respond_trade(v_id, 2, 'SHRUG');
    perform pg_temp.ok('an unknown action is refused', false);
  exception when others then
    perform pg_temp.ok('an unknown action is refused', sqlerrm like '%unknown action%');
  end;

  perform pg_temp.ok('the recipient can accept',
    public.fsnv2_respond_trade(v_id, 2, 'ACCEPT') ->> 'status' = 'ACCEPTED');
  perform pg_temp.ok('accepting moves nobody on its own',
    fsnv2.player_owner(pg_temp.draft(), 'h-08') = 1);

  begin
    perform public.fsnv2_respond_trade(v_id, 2, 'REJECT');
    perform pg_temp.ok('an accepted trade cannot be answered twice', false);
  exception when others then
    perform pg_temp.ok('an accepted trade cannot be answered twice',
      sqlerrm like '%is accepted%');
  end;
end $$;

-- An offer nobody answered in time is withdrawn rather than left open.
do $$
declare v_id uuid;
begin
  perform pg_temp.reset_league();
  v_id := (public.fsnv2_propose_trade(pg_temp.league(), 1, 2, jsonb_build_array(
    jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'h-08')),
    now() + interval '1 hour') ->> 'trade_id')::uuid;
  update fsnv2.trades set expires_at = now() - interval '1 minute' where id = v_id;

  perform pg_temp.ok('the sweep cancels it',
    jsonb_array_length(public.fsnv2_expire_trades(pg_temp.league()) -> 'expired') = 1);
  perform pg_temp.ok('and it is CANCELLED, with a reason',
    (select status || '/' || status_detail from fsnv2.trades where id = v_id)
      = 'CANCELLED/expired before it was answered');
end $$;

-- =============================================================================
\echo '— executing a trade: everything moves, or nothing does'
-- =============================================================================
do $$
declare v_id uuid; v_done jsonb;
begin
  perform pg_temp.reset_league();
  -- Nobody in this trade is playing: Gibbs (DET) and Hurts (PHI) both have
  -- scheduled games, so the swap goes through now.
  v_id := (public.fsnv2_propose_trade(pg_temp.league(), 1, 2, jsonb_build_array(
    jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'h-08'),
    jsonb_build_object('sender_team_id', 2, 'asset_type', 'PLAYER', 'asset_id', 'h-07'),
    jsonb_build_object('sender_team_id', 2, 'asset_type', 'FAAB',   'amount', 15)))
    ->> 'trade_id')::uuid;

  begin
    perform public.fsnv2_execute_trade(v_id, pg_temp.at());
    perform pg_temp.ok('a trade nobody accepted cannot be executed', false);
  exception when others then
    perform pg_temp.ok('a trade nobody accepted cannot be executed',
      sqlerrm like '%only an accepted trade%', sqlerrm);
  end;

  perform public.fsnv2_respond_trade(v_id, 2, 'ACCEPT');
  v_done := public.fsnv2_execute_trade(v_id, pg_temp.at());

  perform pg_temp.ok('the trade is EXECUTED', v_done ->> 'status' = 'EXECUTED');
  perform pg_temp.ok('the players have swapped rosters',
    fsnv2.player_owner(pg_temp.draft(), 'h-08') = 2
    and fsnv2.player_owner(pg_temp.draft(), 'h-07') = 1);
  perform pg_temp.ok('each roster is the size it started at',
    fsnv2.roster_size(pg_temp.draft(), 1) = 3 and fsnv2.roster_size(pg_temp.draft(), 2) = 3);
  perform pg_temp.ok('the acquisitions are recorded as trades',
    (select count(*) from fsnv2.draft_picks
      where draft_id = pg_temp.draft() and source = 'trade') = 2);
  perform pg_temp.ok('the FAAB moved out of the sender''s balance',
    (select faab_balance from fsnv2.team_waiver_state
      where league_id = pg_temp.league() and team_id = 2) = 85);
  perform pg_temp.ok('and into the receiver''s',
    (select faab_balance from fsnv2.team_waiver_state
      where league_id = pg_temp.league() and team_id = 1) = 115);
  -- DRAFT_PICK items are migration 0015's: a pick had nowhere to live when
  -- 0014 was written, so this file does not trade one.
  -- supabase/tests/0015_draft_pick_ledger.test.sql covers them.
  perform pg_temp.ok('every asset in the trade is accounted for in the moves',
    jsonb_array_length(v_done -> 'moves') = 3,
    jsonb_array_length(v_done -> 'moves')::text);
  perform pg_temp.ok('executing again is a no-op, not a second swap',
    public.fsnv2_execute_trade(v_id, pg_temp.at()) ->> 'status' = 'EXECUTED'
    and (select count(*) from fsnv2.draft_picks
          where draft_id = pg_temp.draft() and source = 'trade') = 2);
end $$;

-- A trade whose assets moved on between the handshake and the swap.
do $$
declare v_id uuid;
begin
  perform pg_temp.reset_league();
  v_id := (public.fsnv2_propose_trade(pg_temp.league(), 1, 2, jsonb_build_array(
    jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'h-08')))
    ->> 'trade_id')::uuid;
  perform public.fsnv2_respond_trade(v_id, 2, 'ACCEPT');
  -- Team 1 drops the player it had agreed to trade.
  perform fsnv2.apply_roster_change(pg_temp.draft(), 1, null, 'h-08', 'free_agency');

  begin
    perform public.fsnv2_execute_trade(v_id, pg_temp.at());
    perform pg_temp.ok('a trade whose asset has gone is refused at execution', false);
  exception when others then
    perform pg_temp.ok('a trade whose asset has gone is refused at execution',
      sqlerrm like '%is not on%roster%', sqlerrm);
  end;
  perform pg_temp.ok('and nothing was half-applied',
    fsnv2.player_owner(pg_temp.draft(), 'h-08') is null
    and (select status from fsnv2.trades where id = v_id) = 'ACCEPTED');
end $$;

-- =============================================================================
\echo '— the lock guard: a trade mid-game waits for the week to turn'
-- =============================================================================
do $$
declare v_id uuid; v_out jsonb; v_sweep jsonb;
begin
  perform pg_temp.reset_league();
  -- h-11 is Josh Jacobs, whose Packers game is final. Everything else in the
  -- trade is free to move, which is exactly the case that must not half-apply.
  v_id := (public.fsnv2_propose_trade(pg_temp.league(), 3, 1, jsonb_build_array(
    jsonb_build_object('sender_team_id', 3, 'asset_type', 'PLAYER', 'asset_id', 'h-11'),
    jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'h-08')))
    ->> 'trade_id')::uuid;
  perform public.fsnv2_respond_trade(v_id, 1, 'ACCEPT');

  perform pg_temp.ok('the lock report names the locked player',
    (public.fsnv2_trade_lock_report(v_id, pg_temp.at()) -> 0 ->> 'player_id') = 'h-11');

  v_out := public.fsnv2_execute_trade(v_id, pg_temp.at());
  perform pg_temp.ok('the trade is deferred, not executed and not refused',
    v_out ->> 'status' = 'PENDING_NEXT_WEEK');
  perform pg_temp.ok('to the week after the one it was agreed in',
    (v_out ->> 'effective_week')::integer = 4);
  perform pg_temp.ok('and it says who held it up',
    v_out ->> 'status_detail' like '%Josh Jacobs%already started%', v_out ->> 'status_detail');
  perform pg_temp.ok('neither player moved',
    fsnv2.player_owner(pg_temp.draft(), 'h-11') = 3
    and fsnv2.player_owner(pg_temp.draft(), 'h-08') = 1);

  -- The same sweep, still in week 3: nothing is due yet.
  v_sweep := public.fsnv2_process_pending_trades(pg_temp.league(), pg_temp.at());
  perform pg_temp.ok('the sweep leaves it alone while the week has not turned',
    jsonb_array_length(v_sweep -> 'swept') = 0, v_sweep::text);

  -- A week later the Packers game is in the past, not in this week's slate.
  v_sweep := public.fsnv2_process_pending_trades(
    pg_temp.league(), '2026-10-01T12:00:00Z'::timestamptz);
  perform pg_temp.ok('and executes it once the week has turned',
    (v_sweep -> 'swept' -> 0 ->> 'status') = 'EXECUTED', v_sweep::text);
  perform pg_temp.ok('the players swap then',
    fsnv2.player_owner(pg_temp.draft(), 'h-11') = 1
    and fsnv2.player_owner(pg_temp.draft(), 'h-08') = 3);
  perform pg_temp.ok('and the trade records that it had been deferred',
    (select deferred_from_week from fsnv2.trades where id = v_id) = 3);
end $$;

-- =============================================================================
\echo '— the event log the News Desk drains'
-- =============================================================================
do $$
declare v_id uuid; v_feed jsonb; v_claimed jsonb; v_before integer;
begin
  perform pg_temp.reset_league();
  delete from fsnv2.league_events where league_id = pg_temp.league();

  -- One waiver run and one executed trade.
  perform public.fsnv2_submit_waiver_bid(pg_temp.league(), 4, 'hfa-rb', null, 7);
  perform public.fsnv2_process_waivers(pg_temp.league(), pg_temp.at());
  v_id := (public.fsnv2_propose_trade(pg_temp.league(), 1, 2, jsonb_build_array(
    jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'h-08'),
    jsonb_build_object('sender_team_id', 2, 'asset_type', 'PLAYER', 'asset_id', 'h-07')))
    ->> 'trade_id')::uuid;
  perform public.fsnv2_respond_trade(v_id, 2, 'ACCEPT');
  perform public.fsnv2_execute_trade(v_id, pg_temp.at());

  perform pg_temp.ok('the waiver run filed a claim and a summary',
    (select count(*) from fsnv2.league_events
      where league_id = pg_temp.league()
        and event_type in ('WAIVER_CLAIM_AWARDED', 'WAIVER_PROCESSED')) = 2);
  perform pg_temp.ok('the executed trade filed a TRADE_EXECUTED',
    (select count(*) from fsnv2.league_events
      where league_id = pg_temp.league() and event_type = 'TRADE_EXECUTED') = 1);
  perform pg_temp.ok('the Trade Breakdown''s facts are in the payload, not a join away',
    (select payload -> 'items' -> 0 -> 'player' ->> 'name' is not null
       from fsnv2.league_events
      where league_id = pg_temp.league() and event_type = 'TRADE_EXECUTED'));
  perform pg_temp.ok('a proposal is in the feed but not in the article queue',
    (select dispatch_status from fsnv2.league_events
      where league_id = pg_temp.league() and event_type = 'TRADE_PROPOSED') = 'SKIPPED');
  perform pg_temp.ok('valid_from and recorded_at are both set',
    (select bool_and(valid_from is not null and recorded_at is not null)
       from fsnv2.league_events where league_id = pg_temp.league()));

  v_feed := public.fsnv2_league_feed(pg_temp.league());
  perform pg_temp.ok('the feed reads newest first',
    (select bool_and((v_feed -> (n - 1) ->> 'valid_from')::timestamptz
                  >= (v_feed -> n ->> 'valid_from')::timestamptz)
       from generate_series(1, jsonb_array_length(v_feed) - 1) n));
  perform pg_temp.ok('the feed filters by type',
    jsonb_array_length(public.fsnv2_league_feed(
      pg_temp.league(), null, 50, array['TRADE_EXECUTED'])) = 1);

  -- The pipeline's intake.
  select count(*) into v_before from fsnv2.league_events
   where league_id = pg_temp.league() and dispatch_status = 'PENDING';
  v_claimed := public.fsnv2_claim_league_events(50, pg_temp.league());
  perform pg_temp.ok('claiming hands over every pending event',
    jsonb_array_length(v_claimed) = v_before, jsonb_array_length(v_claimed)::text);
  perform pg_temp.ok('and the queue is empty afterwards',
    (select count(*) from fsnv2.league_events
      where league_id = pg_temp.league() and dispatch_status = 'PENDING') = 0);
  perform pg_temp.ok('a second claim gets nothing',
    jsonb_array_length(public.fsnv2_claim_league_events(50, pg_temp.league())) = 0);

  -- A worker that failed puts its event back.
  perform public.fsnv2_complete_league_event(
    (v_claimed -> 0 ->> 'id')::uuid, false, 'the Beat Reporter timed out');
  perform pg_temp.ok('a failed dispatch is queued again, with the error recorded',
    (select count(*) from fsnv2.league_events
      where league_id = pg_temp.league() and dispatch_status = 'PENDING'
        and dispatch_error = 'the Beat Reporter timed out') = 1);
end $$;

-- A retried cron run must not produce a second article for the same claim.
do $$
declare v_first uuid; v_again uuid;
begin
  v_first := fsnv2.emit_league_event(pg_temp.league(), 'WAIVER_PROCESSED',
    '{"n":1}'::jsonb, 'league', null, now(), 3, 2026, 'dedupe-harness');
  v_again := fsnv2.emit_league_event(pg_temp.league(), 'WAIVER_PROCESSED',
    '{"n":2}'::jsonb, 'league', null, now(), 3, 2026, 'dedupe-harness');
  perform pg_temp.ok('re-emitting a keyed event returns the first row',
    v_first = v_again);
  perform pg_temp.ok('and files only one',
    (select count(*) from fsnv2.league_events where dedupe_key = 'dedupe-harness') = 1);
  perform pg_temp.ok('with the facts it was first given',
    (select payload ->> 'n' from fsnv2.league_events
      where dedupe_key = 'dedupe-harness') = '1');
end $$;

\echo ''
\echo 'all cases passed'
rollback;
