-- =============================================================================
-- Regression harness for migration 0015 — the draft pick ledger.
--
-- The question this file answers is the one 0014 could not: does a traded draft
-- pick actually change hands, and does the draft that follows honour it?
--
--   createdb fsn
--   psql -d fsn -c 'create role anon; create role authenticated; create role service_role;'
--   for f in supabase/migrations/0*.sql; do psql -v ON_ERROR_STOP=1 -d fsn -f "$f"; done
--   psql -v ON_ERROR_STOP=1 -d fsn -f supabase/tests/0015_draft_pick_ledger.test.sql
--
-- One transaction, ending in a rollback, so it can be pointed at a scratch copy
-- of a real database without leaving anything behind. One line per case; it
-- raises on the first failure.
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
-- A four-team league whose draft is complete (so rosters exist to trade from),
-- and a ledger for the season after it.
create temporary table ids (league uuid, draft uuid);
insert into ids values (gen_random_uuid(), gen_random_uuid());

insert into fsnv2.leagues (id, name, total_teams)
select league, 'Ledger League', 4 from ids;

insert into fsnv2.drafts (id, league_id, rounds, status, season, teams)
select draft, league, 3, 'complete', 2026,
  jsonb_build_array(
    jsonb_build_object('slot',1,'name','Alpha','abbr','ALP','is_user',true),
    jsonb_build_object('slot',2,'name','Bravo','abbr','BRV','is_user',false),
    jsonb_build_object('slot',3,'name','Charlie','abbr','CHR','is_user',false),
    jsonb_build_object('slot',4,'name','Delta','abbr','DLT','is_user',false))
from ids;

insert into fsnv2.players (id, name, position, team, adp) values
  ('L-01','Ledger QB1','QB','KC',1),  ('L-02','Ledger RB1','RB','ATL',2),
  ('L-03','Ledger WR1','WR','CIN',3), ('L-04','Ledger QB2','QB','BUF',4),
  ('L-05','Ledger RB2','RB','PHI',5), ('L-06','Ledger WR2','WR','MIN',6),
  ('L-07','Ledger QB3','QB','PHI',7), ('L-08','Ledger RB3','RB','DET',8),
  ('L-09','Ledger WR3','WR','DET',9), ('L-10','Ledger QB4','QB','LAR',10),
  ('L-11','Ledger RB4','RB','NYJ',11),('L-12','Ledger WR4','WR','SEA',12)
on conflict (id) do nothing;

insert into fsnv2.draft_picks (draft_id, pick_number, round, team_id, player_id, source)
select draft, n, ((n - 1) / 4) + 1, public.fsnv2_snake_team(n, 4, 'snake'),
       format('L-%s', lpad(n::text, 2, '0')), 'manual'
  from ids, generate_series(1, 12) n;

create or replace function pg_temp.league() returns uuid
language sql stable as $$ select league from ids limit 1 $$;
create or replace function pg_temp.draft() returns uuid
language sql stable as $$ select draft from ids limit 1 $$;
create or replace function pg_temp.pick_of(p_season integer, p_round integer, p_team integer)
returns fsnv2.draft_pick_assets language sql stable as $$
  select a.* from fsnv2.draft_pick_assets a
   where a.league_id = pg_temp.league() and a.season = p_season
     and a.round = p_round and a.original_team_id = p_team;
$$;

-- =============================================================================
\echo '— before the ledger exists, nothing has changed'
-- =============================================================================
do $$
begin
  perform pg_temp.ok('an unseeded league has an empty draft order',
    public.fsnv2_draft_order(pg_temp.league(), 2027) = '{}'::jsonb);
  perform pg_temp.ok('and pick ownership is still the snake formula',
    public.fsnv2_draft_pick_owner(pg_temp.draft(), 5) = public.fsnv2_snake_team(5, 4, 'snake'));
  perform pg_temp.ok('which for four teams puts pick 5 on team 4',
    public.fsnv2_draft_pick_owner(pg_temp.draft(), 5) = 4);
end $$;

-- =============================================================================
\echo '— seeding'
-- =============================================================================
do $$
declare v_ledger jsonb;
begin
  v_ledger := public.fsnv2_seed_draft_picks(pg_temp.league(), 2027, 3);

  perform pg_temp.ok('a 4-team, 3-round season is 12 slots',
    jsonb_array_length(v_ledger) = 12, jsonb_array_length(v_ledger)::text);
  perform pg_temp.ok('every slot starts with its original owner holding it',
    (select bool_and((p ->> 'original_team_id') = (p ->> 'current_team_id'))
       from jsonb_array_elements(v_ledger) p));
  perform pg_temp.ok('nothing is marked traded',
    (select bool_and(not (p ->> 'traded')::boolean)
       from jsonb_array_elements(v_ledger) p));
  perform pg_temp.ok('the order is the league''s own snake order',
    (select bool_and((p ->> 'current_team_id')::integer
                     = public.fsnv2_snake_team((p ->> 'pick_number')::integer, 4, 'snake'))
       from jsonb_array_elements(v_ledger) p));
  perform pg_temp.ok('round 2 runs 4, 3, 2, 1',
    (select array_agg(a.current_team_id order by a.pick_number)
       from fsnv2.draft_pick_assets a
      where a.league_id = pg_temp.league() and a.season = 2027 and a.round = 2)
    = array[4, 3, 2, 1]);
  perform pg_temp.ok('a pick carries a slug a client can send back',
    (pg_temp.pick_of(2027, 2, 3)).id is not null
    and fsnv2.draft_pick_slug(pg_temp.pick_of(2027, 2, 3)) = '2027-R2-T3');
  perform pg_temp.ok('and a label a person can read',
    fsnv2.draft_pick_label(pg_temp.pick_of(2027, 2, 3), pg_temp.draft()) = '2027 Round 2');
end $$;

do $$
declare v_before integer; v_after integer;
begin
  select count(*) into v_before from fsnv2.draft_pick_assets
   where league_id = pg_temp.league() and season = 2027;
  perform public.fsnv2_seed_draft_picks(pg_temp.league(), 2027, 3);
  select count(*) into v_after from fsnv2.draft_pick_assets
   where league_id = pg_temp.league() and season = 2027;
  perform pg_temp.ok('re-seeding the same season adds nothing', v_before = v_after);

  -- Extending the draft adds the new rounds and leaves the old ones alone.
  perform public.fsnv2_seed_draft_picks(pg_temp.league(), 2027, 4);
  perform pg_temp.ok('extending the draft adds the missing round',
    (select count(*) from fsnv2.draft_pick_assets
      where league_id = pg_temp.league() and season = 2027) = 16);
  perform pg_temp.ok('a season nobody seeded is still empty',
    public.fsnv2_draft_order(pg_temp.league(), 2028) = '{}'::jsonb);
end $$;

-- A league seeded after its draft has started must not offer a spent pick.
do $$
begin
  -- The fixture's 2026 draft is complete: all twelve picks are made.
  perform public.fsnv2_seed_draft_picks(pg_temp.league(), 2026, 3);
  perform pg_temp.ok('seeding mid-draft stamps the picks already made',
    (select count(*) from fsnv2.draft_pick_assets
      where league_id = pg_temp.league() and season = 2026
        and used_by_pick_id is not null) = 12);
  perform pg_temp.ok('so every slot of a finished season reads as used',
    (select bool_and((p ->> 'used')::boolean)
       from jsonb_array_elements(public.fsnv2_draft_pick_ledger(pg_temp.league(), 2026)) p));

  begin
    perform public.fsnv2_propose_trade(pg_temp.league(), 1, 2, jsonb_build_array(
      jsonb_build_object('sender_team_id', 1, 'asset_type', 'DRAFT_PICK', 'asset_id', '2026-R1')));
    perform pg_temp.ok('a pick that has already been used cannot be traded', false);
  exception when others then
    perform pg_temp.ok('a pick that has already been used cannot be traded',
      sqlerrm like '%already been used%', sqlerrm);
  end;
end $$;

-- =============================================================================
\echo '— trading a pick'
-- =============================================================================
do $$
declare v_trade jsonb; v_id uuid; v_pick fsnv2.draft_pick_assets;
begin
  -- Bravo (2) sends its own 2027 second to Alpha (1) for a player.
  v_trade := public.fsnv2_propose_trade(pg_temp.league(), 2, 1, jsonb_build_array(
    jsonb_build_object('sender_team_id', 2, 'asset_type', 'DRAFT_PICK', 'asset_id', '2027-R2'),
    jsonb_build_object('sender_team_id', 1, 'asset_type', 'PLAYER', 'asset_id', 'L-08')));
  v_id := (v_trade ->> 'trade_id')::uuid;

  perform pg_temp.ok('a bare "2027-R2" resolves to the sender''s own pick',
    (select asset_id from fsnv2.trade_items
      where trade_id = v_id and asset_type = 'DRAFT_PICK')
    = (pg_temp.pick_of(2027, 2, 2)).id::text);
  perform pg_temp.ok('the offer renders the pick, not a bare id',
    (select i -> 'draft_pick' ->> 'label' from jsonb_array_elements(v_trade -> 'items') i
      where i ->> 'asset_type' = 'DRAFT_PICK') = '2027 Round 2');
  perform pg_temp.ok('nothing has moved yet',
    (pg_temp.pick_of(2027, 2, 2)).current_team_id = 2);

  perform public.fsnv2_respond_trade(v_id, 1, 'ACCEPT');
  perform public.fsnv2_execute_trade(v_id, '2026-09-26T12:00:00Z'::timestamptz);

  v_pick := pg_temp.pick_of(2027, 2, 2);
  perform pg_temp.ok('the pick is now the other team''s', v_pick.current_team_id = 1);
  perform pg_temp.ok('its identity did not change', v_pick.original_team_id = 2);
  perform pg_temp.ok('and it reads as a traded pick, from whom',
    fsnv2.draft_pick_label(v_pick, pg_temp.draft()) = '2027 Round 2 (from Bravo)');
  perform pg_temp.ok('the draft order moved with it',
    (public.fsnv2_draft_order(pg_temp.league(), 2027) ->> v_pick.pick_number::text)::integer = 1);
  perform pg_temp.ok('the player went the other way',
    fsnv2.player_owner(pg_temp.draft(), 'L-08') = 2);
  perform pg_temp.ok('the ledger shows one traded pick and no more',
    (select count(*) from fsnv2.draft_pick_assets
      where league_id = pg_temp.league() and season = 2027
        and original_team_id <> current_team_id) = 1);
end $$;

do $$
declare v_payload jsonb;
begin
  perform pg_temp.ok('the executed trade filed an event naming the pick',
    (select count(*) from fsnv2.league_events
      where league_id = pg_temp.league() and event_type = 'TRADE_EXECUTED') = 1);

  select payload into v_payload from fsnv2.league_events
   where league_id = pg_temp.league() and event_type = 'TRADE_EXECUTED';
  perform pg_temp.ok('the Trade Breakdown''s facts include the pick that moved',
    (select bool_or(m -> 'draft_pick' ->> 'label' = '2027 Round 2 (from Bravo)'
                    and (m ->> 'to_team_id')::integer = 1)
       from jsonb_array_elements(v_payload -> 'moves') m), v_payload::text);
  perform pg_temp.ok('and no longer says the pick was only recorded',
    not (v_payload::text like '%no draft-pick ledger%'));
end $$;

-- A pick can be traded on, and keeps saying whose it was.
do $$
declare v_id uuid; v_pick fsnv2.draft_pick_assets;
begin
  v_id := (public.fsnv2_propose_trade(pg_temp.league(), 1, 3, jsonb_build_array(
    jsonb_build_object('sender_team_id', 1, 'asset_type', 'DRAFT_PICK',
                       'asset_id', '2027-R2-T2')))
    ->> 'trade_id')::uuid;
  perform public.fsnv2_respond_trade(v_id, 3, 'ACCEPT');
  perform public.fsnv2_execute_trade(v_id, '2026-09-26T12:00:00Z'::timestamptz);

  v_pick := pg_temp.pick_of(2027, 2, 2);
  perform pg_temp.ok('a pick acquired in one trade can be sent on in the next',
    v_pick.current_team_id = 3);
  perform pg_temp.ok('and it is still Bravo''s pick, two trades later',
    v_pick.original_team_id = 2
    and fsnv2.draft_pick_label(v_pick, pg_temp.draft()) = '2027 Round 2 (from Bravo)');
end $$;

-- =============================================================================
\echo '— what cannot be traded'
-- =============================================================================
do $$
begin
  begin
    -- Bravo already sent this one; '2027-R2' now resolves to a pick it does
    -- not hold.
    perform public.fsnv2_propose_trade(pg_temp.league(), 2, 4, jsonb_build_array(
      jsonb_build_object('sender_team_id', 2, 'asset_type', 'DRAFT_PICK', 'asset_id', '2027-R2')));
    perform pg_temp.ok('a pick you have already traded away cannot be traded again', false);
  exception when others then
    perform pg_temp.ok('a pick you have already traded away cannot be traded again',
      sqlerrm like '%not%pick to trade%', sqlerrm);
  end;

  begin
    perform public.fsnv2_propose_trade(pg_temp.league(), 2, 4, jsonb_build_array(
      jsonb_build_object('sender_team_id', 2, 'asset_type', 'DRAFT_PICK', 'asset_id', '2027-R2-T3')));
    perform pg_temp.ok('nor can somebody else''s', false);
  exception when others then
    perform pg_temp.ok('nor can somebody else''s', sqlerrm like '%not%pick to trade%', sqlerrm);
  end;

  begin
    perform public.fsnv2_propose_trade(pg_temp.league(), 2, 4, jsonb_build_array(
      jsonb_build_object('sender_team_id', 2, 'asset_type', 'DRAFT_PICK', 'asset_id', '2031-R9')));
    perform pg_temp.ok('a pick no season has is refused, with the remedy', false);
  exception when others then
    perform pg_temp.ok('a pick no season has is refused, with the remedy',
      sqlerrm like '%seed the ledger%', sqlerrm);
  end;

  begin
    perform public.fsnv2_propose_trade(pg_temp.league(), 2, 4, jsonb_build_array(
      jsonb_build_object('sender_team_id', 2, 'asset_type', 'DRAFT_PICK', 'asset_id', 'next years 2nd')));
    perform pg_temp.ok('an unreadable label is refused, with the spellings', false);
  exception when others then
    perform pg_temp.ok('an unreadable label is refused, with the spellings',
      sqlerrm like '%2027-R2%', sqlerrm);
  end;

  perform pg_temp.ok('and none of those left a trade behind',
    (select count(*) from fsnv2.trades where league_id = pg_temp.league()) = 2);
end $$;

-- =============================================================================
\echo '— the draft honours the ledger'
-- =============================================================================
create temporary table live (league uuid, draft uuid);
insert into live values (gen_random_uuid(), gen_random_uuid());

insert into fsnv2.leagues (id, name, total_teams)
select league, 'Draft Room League', 4 from live;
insert into fsnv2.drafts (id, league_id, rounds, status, season, current_pick, teams)
select draft, league, 2, 'in_progress', 2026, 1,
  jsonb_build_array(
    jsonb_build_object('slot',1,'name','Alpha','abbr','ALP','is_user',true),
    jsonb_build_object('slot',2,'name','Bravo','abbr','BRV','is_user',false),
    jsonb_build_object('slot',3,'name','Charlie','abbr','CHR','is_user',false),
    jsonb_build_object('slot',4,'name','Delta','abbr','DLT','is_user',false))
from live;

do $$
declare
  v_league uuid := (select league from live);
  v_draft  uuid := (select draft from live);
  v_pick   uuid;
  v_state  jsonb;
begin
  perform public.fsnv2_seed_draft_picks(v_league, 2026, 2);

  -- Bravo's first-rounder (pick 2) goes to Delta.
  update fsnv2.draft_pick_assets set current_team_id = 4
   where league_id = v_league and season = 2026 and pick_number = 2;

  perform pg_temp.ok('the ledger says pick 2 is Delta''s now',
    public.fsnv2_draft_pick_owner(v_draft, 2) = 4);
  perform pg_temp.ok('while the snake formula still says Bravo',
    public.fsnv2_snake_team(2, 4, 'snake') = 2);

  -- Pick 1 is untraded and behaves exactly as it always did.
  perform public.fsnv2_record_pick(v_draft, 1, 'L-01', 1, false, 'manual');
  perform pg_temp.ok('an untraded pick is recorded as before',
    (select team_id from fsnv2.draft_picks where draft_id = v_draft and pick_number = 1) = 1);
  perform pg_temp.ok('and its ledger slot is stamped with the selection',
    (select a.used_by_pick_id from fsnv2.draft_pick_assets a
      where a.league_id = v_league and a.season = 2026 and a.pick_number = 1)
    = (select id from fsnv2.draft_picks where draft_id = v_draft and pick_number = 1));

  begin
    -- A client that computed the snake order itself and has not reloaded.
    perform public.fsnv2_record_pick(v_draft, 2, 'L-02', 2, false, 'manual');
    perform pg_temp.ok('a selection from the team that traded the pick is refused', false);
  exception when others then
    perform pg_temp.ok('a selection from the team that traded the pick is refused',
      sqlerrm like '%was traded%belongs to team 4%', sqlerrm);
  end;

  perform public.fsnv2_record_pick(v_draft, 2, 'L-02', 4, false, 'manual');
  perform pg_temp.ok('and accepted from the team that acquired it',
    (select team_id from fsnv2.draft_picks where draft_id = v_draft and pick_number = 2) = 4);
  perform pg_temp.ok('a traded pick is marked used like any other',
    (select a.used_by_pick_id is not null from fsnv2.draft_pick_assets a
      where a.league_id = v_league and a.season = 2026 and a.pick_number = 2));

  -- Undo releases the slot with no extra bookkeeping: the FK does it.
  perform public.fsnv2_undo_pick(v_draft);
  perform pg_temp.ok('undoing a pick frees its ledger slot again',
    (select a.used_by_pick_id is null from fsnv2.draft_pick_assets a
      where a.league_id = v_league and a.season = 2026 and a.pick_number = 2));
  perform pg_temp.ok('and the pick is still Delta''s to make',
    public.fsnv2_draft_pick_owner(v_draft, 2) = 4);

  -- Resetting the draft frees every slot the same way.
  perform public.fsnv2_record_pick(v_draft, 2, 'L-02', 4, false, 'manual');
  perform public.fsnv2_reset_draft(v_draft);
  perform pg_temp.ok('resetting the draft frees them all',
    (select count(*) from fsnv2.draft_pick_assets a
      where a.league_id = v_league and a.season = 2026 and a.used_by_pick_id is not null) = 0);

  v_state := public.fsnv2_draft_state(v_draft);
  perform pg_temp.ok('the hydrate carries the draft order for the browser',
    (v_state -> 'pick_order' ->> '2')::integer = 4, (v_state -> 'pick_order')::text);
  perform pg_temp.ok('and the ledger behind it',
    jsonb_array_length(v_state -> 'pick_ledger') = 8);
  perform pg_temp.ok('a draft knows which season it is',
    (v_state -> 'draft' ->> 'season')::integer = 2026);
end $$;

-- An unseeded league's draft is untouched by any of this.
do $$
declare
  v_league uuid := gen_random_uuid();
  v_draft  uuid := gen_random_uuid();
begin
  insert into fsnv2.leagues (id, name, total_teams) values (v_league, 'Unseeded League', 4);
  insert into fsnv2.drafts (id, league_id, rounds, status, current_pick, teams)
  values (v_draft, v_league, 2, 'in_progress', 1,
    jsonb_build_array(jsonb_build_object('slot',1,'name','Alpha','is_user',true)));

  perform pg_temp.ok('a draft with no ledger defaults its season to the clock''s',
    (select season from fsnv2.drafts where id = v_draft)
    = public.fsnv2_current_nfl_season());
  perform public.fsnv2_record_pick(v_draft, 1, 'L-03', 1, false, 'manual');
  perform public.fsnv2_record_pick(v_draft, 2, 'L-04', 2, false, 'manual');
  perform pg_temp.ok('and records picks in snake order exactly as 0002 did',
    (select array_agg(team_id order by pick_number) from fsnv2.draft_picks
      where draft_id = v_draft) = array[1, 2]);
  perform pg_temp.ok('with nothing written to the ledger',
    (select count(*) from fsnv2.draft_pick_assets where league_id = v_league) = 0);
end $$;

\echo ''
\echo 'all cases passed'
rollback;
