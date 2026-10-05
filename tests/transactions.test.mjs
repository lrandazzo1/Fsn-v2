/**
 * Terminal test-suite for the waiver wire and the trade engine.
 *   node tests/transactions.test.mjs
 *
 * Two halves, for the two things that can go wrong with a transaction engine
 * split between Postgres and the browser:
 *
 *   1. the rules, in js/transactions.js — the order a sealed-bid board is
 *      walked, what settling it produces, what makes a trade legal, and which
 *      players in one are frozen by a game that has already started. These are
 *      mirrors of `fsnv2_waiver_board`, `fsnv2.process_league_waivers`,
 *      `fsnv2.assert_trade_valid` and `fsnv2_execute_trade`'s lock guard, and
 *      the cases below are the same cases
 *      supabase/tests/0014_waivers_and_trades.test.sql puts to the database.
 *      Where the two disagree, the roster the manager sees and the roster the
 *      league has stop being the same roster.
 *
 *   2. the four routes — that a malformed trade never reaches the database,
 *      that an unauthorised cron call is refused, that a missing migration is a
 *      503 naming the file, and that a trade held over for a live game comes
 *      back as a 202 rather than a success or a failure.
 *
 * The engines themselves are not exercised here: settling a waiver board moves
 * rosters in one transaction, and that needs a database. The SQL harness is
 * where that half is covered.
 */

import assert from 'node:assert/strict';
import {
  ROSTER_SLOTS,
  TRADE_STATUSES,
  draftPickLabel,
  draftPickSlug,
  findDraftPick,
  lockedTradePlayers,
  parseDraftPickRef,
  tradeDraftPickRefs,
  normalizeBid,
  normalizeTradeItems,
  resolveWaiverBoard,
  sortWaiverBids,
  tradeDeferralMessage,
  tradeMustWait,
  tradePlayerIds,
  validateTradeProposal
} from '../js/transactions.js';
import { buildGameSchedule } from '../js/gameLock.js';
import waiverHandler from '../api/waivers/process.js';
import proposeHandler from '../api/trades/propose.js';
import respondHandler from '../api/trades/respond.js';
import executeHandler from '../api/trades/execute.js';

/* --------------------------------------------------------------- harness -- */

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  \u001b[31m✗\u001b[0m ${name}\n      ${error.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  \u001b[31m✗\u001b[0m ${name}\n      ${error.message}`);
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

/* -------------------------------------------------------------- fixtures -- */

const LEAGUE = '11111111-1111-1111-1111-111111111111';
const TRADE = '33333333-3333-3333-3333-333333333333';

/**
 * The board from the SQL harness: teams 1 and 2 tie at $10, team 3 outbids
 * both, team 4 bids least. Team 1 bid *after* team 2 and still comes first,
 * because it holds waiver priority 1 — the league order breaks a tie on money
 * before the clock does.
 */
const BOARD = [
  { id: 'b-2', team_id: 2, player_id: 'fa-rb', bid_amount: 10, waiver_priority: 2,
    created_at: '2026-09-22T18:00:00Z', priority: 1 },
  { id: 'b-1', team_id: 1, player_id: 'fa-rb', bid_amount: 10, waiver_priority: 1,
    created_at: '2026-09-22T19:00:00Z', priority: 1 },
  { id: 'b-3', team_id: 3, player_id: 'fa-rb', bid_amount: 25, waiver_priority: 3,
    created_at: '2026-09-22T20:00:00Z', priority: 1 },
  { id: 'b-4', team_id: 4, player_id: 'fa-rb', bid_amount: 1, waiver_priority: 4,
    created_at: '2026-09-21T09:00:00Z', priority: 1 }
];

const FULL_BUDGETS = { 1: 100, 2: 100, 3: 100, 4: 100 };
const DRAFTED = { 1: 3, 2: 3, 3: 3, 4: 3 };

/** Week 3 of 2026: Green Bay at Minnesota is final, the rest have not started. */
const WEEK3 = buildGameSchedule([
  { home_team: 'MIN', away_team: 'GB', kickoff: '2026-09-24T17:00:00Z', status: 'final' },
  { home_team: 'PHI', away_team: 'KC', kickoff: '2026-12-31T17:00:00Z', status: 'scheduled' },
  { home_team: 'CIN', away_team: 'DET', kickoff: '2026-12-31T17:00:00Z', status: 'scheduled' }
]);
const NOW = Date.parse('2026-09-26T12:00:00Z');

const PLAYERS = {
  'h-07': { id: 'h-07', name: 'Jalen Hurts', position: 'QB', team: 'PHI' },
  'h-08': { id: 'h-08', name: 'Jahmyr Gibbs', position: 'RB', team: 'DET' },
  'h-11': { id: 'h-11', name: 'Josh Jacobs', position: 'RB', team: 'GB' },
  'h-06': { id: 'h-06', name: 'Justin Jefferson', position: 'WR', team: 'MIN' }
};

/* =========================================================================
 * 1. The rules
 * ========================================================================= */

section('the board is ordered like the auction');

test('the highest bid is walked first', () => {
  assert.deepEqual(sortWaiverBids(BOARD).map((bid) => bid.teamId), [3, 1, 2, 4]);
});

test('a tie on money is broken by waiver priority, not by time', () => {
  const [, second, third] = sortWaiverBids(BOARD);
  assert.equal(second.teamId, 1, 'priority 1 comes before priority 2');
  assert.equal(third.teamId, 2);
  assert.ok(second.createdAt > third.createdAt, 'even though it was submitted later');
});

test('a tie on money and priority is broken by the clock', () => {
  const order = sortWaiverBids([
    { id: 'late', team_id: 5, bid_amount: 5, waiver_priority: 1, created_at: '2026-09-22T20:00:00Z' },
    { id: 'early', team_id: 6, bid_amount: 5, waiver_priority: 1, created_at: '2026-09-22T08:00:00Z' }
  ]);
  assert.deepEqual(order.map((bid) => bid.bidId), ['early', 'late']);
});

test('the input array is left alone', () => {
  const before = BOARD.map((bid) => bid.id);
  sortWaiverBids(BOARD);
  assert.deepEqual(BOARD.map((bid) => bid.id), before);
});

test('either spelling of a row reads the same', () => {
  const snake = normalizeBid({ id: 'x', team_id: 2, bid_amount: '12.50', drop_player_id: 'p-1' });
  const camel = normalizeBid({ bidId: 'x', teamId: 2, bidAmount: 12.5, dropPlayerId: 'p-1' });
  assert.equal(snake.bidAmount, camel.bidAmount);
  assert.equal(snake.dropPlayerId, camel.dropPlayerId);
});

test('a team with no waiver-state row sits at its slot number', () => {
  assert.equal(normalizeBid({ id: 'x', team_id: 7, bid_amount: 1 }).waiverPriority, 7);
});

section('settling the board');

test('one winner, and everyone else is told the player is gone', () => {
  const { outcomes } = resolveWaiverBoard(BOARD, {
    budgets: FULL_BUDGETS,
    rosterSizes: DRAFTED
  });
  assert.deepEqual(
    outcomes.map((row) => `${row.teamId}:${row.status}`),
    ['3:SUCCESSFUL', '1:FAILED_PLAYER_TAKEN', '2:FAILED_PLAYER_TAKEN', '4:FAILED_PLAYER_TAKEN']
  );
});

test('the winner pays its own bid, not the runner-up’s price', () => {
  const { budgets } = resolveWaiverBoard(BOARD, { budgets: FULL_BUDGETS, rosterSizes: DRAFTED });
  assert.equal(budgets[3], 75);
  assert.equal(budgets[1], 100, 'a losing bid costs nothing');
});

test('a second claim is checked against what the first one left', () => {
  // $40 twice against a $60 budget: the SQL harness’s case, to the dollar.
  const { outcomes, budgets } = resolveWaiverBoard(
    [
      { id: 'a', team_id: 2, player_id: 'fa-rb', bid_amount: 40, waiver_priority: 2,
        created_at: '2026-09-22T18:00:00Z' },
      { id: 'b', team_id: 2, player_id: 'fa-wr', bid_amount: 40, waiver_priority: 2,
        created_at: '2026-09-22T19:00:00Z' }
    ],
    { budgets: { 2: 60 }, rosterSizes: { 2: 3 } }
  );
  assert.deepEqual(outcomes.map((row) => row.status), ['SUCCESSFUL', 'FAILED_INSUFFICIENT_FAAB']);
  assert.equal(budgets[2], 20, 'the budget cannot go negative');
});

test('a drop can only be spent once', () => {
  const { outcomes } = resolveWaiverBoard(
    [
      { id: 'first', team_id: 1, player_id: 'fa-wr', drop_player_id: 'h-09', bid_amount: 20,
        waiver_priority: 1, created_at: '2026-09-22T18:00:00Z' },
      { id: 'second', team_id: 1, player_id: 'fa-te', drop_player_id: 'h-09', bid_amount: 5,
        waiver_priority: 1, created_at: '2026-09-22T18:30:00Z' }
    ],
    { budgets: { 1: 100 }, rosterSizes: { 1: 15 }, ownedBy: { 'h-09': 1 } }
  );
  assert.deepEqual(outcomes.map((row) => row.status), ['SUCCESSFUL', 'FAILED_PLAYER_TAKEN']);
  assert.match(outcomes[1].detail, /already left the roster/);
});

test('a full roster with no drop named cannot take anyone', () => {
  const { outcomes } = resolveWaiverBoard(
    [{ id: 'x', team_id: 1, player_id: 'fa-rb', bid_amount: 5, waiver_priority: 1 }],
    { budgets: { 1: 100 }, rosterSizes: { 1: 15 } }
  );
  assert.equal(outcomes[0].status, 'FAILED_PLAYER_TAKEN');
  assert.match(outcomes[0].detail, /roster was full/);
});

test('a claim that would drop a player mid-game is refused, not awarded', () => {
  const { outcomes } = resolveWaiverBoard(
    [{ id: 'x', team_id: 3, player_id: 'fa-rb', drop_player_id: 'h-11', bid_amount: 30,
       waiver_priority: 1 }],
    { budgets: { 3: 100 }, rosterSizes: { 3: 15 }, ownedBy: { 'h-11': 3 },
      lockedPlayerIds: ['h-11'] }
  );
  assert.equal(outcomes[0].status, 'FAILED_PLAYER_TAKEN');
  assert.match(outcomes[0].detail, /locked because their game has already started/);
});

test('a bid on a player somebody already holds never gets as far as the money', () => {
  const { outcomes } = resolveWaiverBoard(
    [{ id: 'x', team_id: 1, player_id: 'h-07', bid_amount: 500, waiver_priority: 1 }],
    { budgets: { 1: 10 }, rosterSizes: { 1: 3 }, ownedBy: { 'h-07': 2 } }
  );
  assert.equal(outcomes[0].status, 'FAILED_PLAYER_TAKEN', 'not FAILED_INSUFFICIENT_FAAB');
});

test('an empty board settles to nothing', () => {
  assert.deepEqual(resolveWaiverBoard([], {}).outcomes, []);
  assert.deepEqual(resolveWaiverBoard(null, {}).awarded, []);
});

section('what makes a trade legal');

test('items normalise to the shape the RPC wants', () => {
  assert.deepEqual(
    normalizeTradeItems([
      { senderTeamId: 1, assetType: 'player', assetId: 'h-08' },
      { sender_team_id: 2, asset_type: 'FAAB', amount: '15' },
      { senderTeamId: 2, assetType: 'DRAFT_PICK', assetId: '2027-R2' }
    ]),
    [
      { sender_team_id: 1, asset_type: 'PLAYER', asset_id: 'h-08', amount: null },
      { sender_team_id: 2, asset_type: 'FAAB', asset_id: null, amount: 15 },
      { sender_team_id: 2, asset_type: 'DRAFT_PICK', asset_id: '2027-R2', amount: null }
    ]
  );
});

test('a malformed item names itself', () => {
  assert.throws(() => normalizeTradeItems([]), /at least one asset/);
  assert.throws(
    () => normalizeTradeItems([{ senderTeamId: 1, assetType: 'PLAYER' }]),
    /item 1 is a PLAYER with no asset id/
  );
  assert.throws(
    () => normalizeTradeItems([{ senderTeamId: 1, assetType: 'FAAB', amount: 0 }]),
    /item 1 sends FAAB but no positive amount/
  );
  assert.throws(
    () => normalizeTradeItems([{ senderTeamId: 1, assetType: 'CASH', assetId: 'x' }]),
    /expected PLAYER, FAAB or DRAFT_PICK/
  );
  assert.throws(
    () => normalizeTradeItems([{ assetType: 'PLAYER', assetId: 'h-08' }]),
    /does not say which team is sending it/
  );
});

test('an even swap both sides own is legal', () => {
  const { ok, errors } = validateTradeProposal({
    items: [
      { senderTeamId: 1, assetType: 'PLAYER', assetId: 'h-08' },
      { senderTeamId: 2, assetType: 'PLAYER', assetId: 'h-07' }
    ],
    proposerTeamId: 1,
    recipientTeamId: 2,
    ownedBy: { 'h-08': 1, 'h-07': 2 },
    rosterSizes: { 1: 15, 2: 15 },
    budgets: FULL_BUDGETS
  });
  assert.equal(ok, true, errors.join('; '));
});

test('offering a player you do not own is not', () => {
  const { ok, errors } = validateTradeProposal({
    items: [{ senderTeamId: 1, assetType: 'PLAYER', assetId: 'h-07' }],
    proposerTeamId: 1,
    recipientTeamId: 2,
    ownedBy: { 'h-07': 2 },
    rosterSizes: { 1: 3, 2: 3 }
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /h-07 is not on team 1's roster/);
});

test('a trade that overfills a roster is not', () => {
  const { ok, errors } = validateTradeProposal({
    items: [{ senderTeamId: 2, assetType: 'PLAYER', assetId: 'h-07' }],
    proposerTeamId: 2,
    recipientTeamId: 1,
    ownedBy: { 'h-07': 2 },
    rosterSizes: { 1: 15, 2: 15 }
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /16 players, over the limit of 15/);
});

test('sending FAAB you do not have is not', () => {
  const { ok, errors } = validateTradeProposal({
    items: [{ senderTeamId: 2, assetType: 'FAAB', amount: 500 }],
    proposerTeamId: 1,
    recipientTeamId: 2,
    rosterSizes: { 1: 3, 2: 3 },
    budgets: { 2: 20 }
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /cannot send \$500 of FAAB/);
});

test('a third party cannot be made to send something', () => {
  const { ok, errors } = validateTradeProposal({
    items: [{ senderTeamId: 3, assetType: 'PLAYER', assetId: 'h-09' }],
    proposerTeamId: 1,
    recipientTeamId: 2,
    ownedBy: { 'h-09': 3 },
    rosterSizes: { 1: 3, 2: 3, 3: 3 }
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /not in this trade/);
});

section('draft picks');

/** Bravo's 2027 second, after Alpha acquired it. */
const LEDGER = [
  { pick_id: 'aa000000-0000-4000-8000-000000000001', season: 2027, round: 1,
    original_team_id: 1, current_team_id: 1, used: false },
  { pick_id: 'aa000000-0000-4000-8000-000000000002', season: 2027, round: 2,
    original_team_id: 2, current_team_id: 1, used: false },
  { pick_id: 'aa000000-0000-4000-8000-000000000003', season: 2027, round: 2,
    original_team_id: 3, current_team_id: 3, used: true }
];
const TEAM_NAMES = { 1: 'Alpha', 2: 'Bravo', 3: 'Charlie', 4: 'Delta' };

test('every spelling the database accepts reads here too', () => {
  assert.deepEqual(parseDraftPickRef('2027-R2'),
    { pickId: null, season: 2027, round: 2, originalTeamId: null });
  assert.deepEqual(parseDraftPickRef('2027-R2-T4'),
    { pickId: null, season: 2027, round: 2, originalTeamId: 4 });
  assert.deepEqual(parseDraftPickRef('2027 Round 2 Team 4'),
    { pickId: null, season: 2027, round: 2, originalTeamId: 4 });
  assert.equal(parseDraftPickRef('aa000000-0000-4000-8000-000000000002').pickId,
    'aa000000-0000-4000-8000-000000000002');
});

test('and anything else is refused rather than guessed at', () => {
  assert.equal(parseDraftPickRef('next year\u2019s 2nd'), null);
  assert.equal(parseDraftPickRef('R2'), null);
  assert.equal(parseDraftPickRef(''), null);
  assert.equal(parseDraftPickRef(null), null);
});

test('a pick that has changed hands says whose it was', () => {
  assert.equal(draftPickLabel(LEDGER[0], TEAM_NAMES), '2027 Round 1');
  assert.equal(draftPickLabel(LEDGER[1], TEAM_NAMES), '2027 Round 2 (from Bravo)');
  assert.equal(draftPickSlug(2027, 2, 2), '2027-R2-T2');
});

test('a bare label resolves against the sending team', () => {
  // Alpha sending '2027-R2' means Alpha's own second, not the one it acquired.
  assert.equal(findDraftPick('2027-R2', LEDGER, 1), null,
    'Alpha has no 2027 second of its own in this ledger');
  assert.equal(findDraftPick('2027-R2', LEDGER, 2), LEDGER[1],
    'Bravo\u2019s own second is the one the label names');
  assert.equal(findDraftPick('2027-R2-T2', LEDGER, 4), LEDGER[1],
    'and naming the team works from either side');
});

test('the refs a trade would move come back in order', () => {
  assert.deepEqual(
    tradeDraftPickRefs([
      { senderTeamId: 1, assetType: 'PLAYER', assetId: 'h-08' },
      { senderTeamId: 1, assetType: 'DRAFT_PICK', assetId: '2027-R2-T2' },
      { senderTeamId: 2, assetType: 'DRAFT_PICK', assetId: '2027-R1' }
    ]),
    ['2027-R2-T2', '2027-R1']
  );
});

test('an unreadable pick never leaves the client', () => {
  assert.throws(
    () => normalizeTradeItems([{ senderTeamId: 1, assetType: 'DRAFT_PICK', assetId: 'next year' }]),
    /cannot read "next year" as a draft pick/
  );
});

test('trading a pick you hold is legal, and costs no roster space', () => {
  const { ok, errors } = validateTradeProposal({
    items: [{ senderTeamId: 1, assetType: 'DRAFT_PICK', assetId: '2027-R2-T2' }],
    proposerTeamId: 1,
    recipientTeamId: 4,
    rosterSizes: { 1: 15, 4: 15 },
    ledger: LEDGER,
    teamNames: TEAM_NAMES
  });
  assert.equal(ok, true, errors.join('; '));
});

test('trading one you do not hold is not', () => {
  const { ok, errors } = validateTradeProposal({
    items: [{ senderTeamId: 2, assetType: 'DRAFT_PICK', assetId: '2027-R2' }],
    proposerTeamId: 2,
    recipientTeamId: 4,
    rosterSizes: { 2: 3, 4: 3 },
    ledger: LEDGER,
    teamNames: TEAM_NAMES
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /2027 Round 2 \(from Bravo\) is not team 2's pick to trade/);
});

test('nor is one that has already been used', () => {
  const { ok, errors } = validateTradeProposal({
    items: [{ senderTeamId: 3, assetType: 'DRAFT_PICK', assetId: '2027-R2-T3' }],
    proposerTeamId: 3,
    recipientTeamId: 4,
    rosterSizes: { 3: 3, 4: 3 },
    ledger: LEDGER,
    teamNames: TEAM_NAMES
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /has already been used/);
});

test('nor one no season has', () => {
  const { ok, errors } = validateTradeProposal({
    items: [{ senderTeamId: 1, assetType: 'DRAFT_PICK', assetId: '2031-R9' }],
    proposerTeamId: 1,
    recipientTeamId: 4,
    rosterSizes: { 1: 3, 4: 3 },
    ledger: LEDGER
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /no such pick in this league's ledger/);
});

test('without a ledger the shape is checked and ownership is left to the database', () => {
  const { ok } = validateTradeProposal({
    items: [{ senderTeamId: 2, assetType: 'DRAFT_PICK', assetId: '2027-R2' }],
    proposerTeamId: 2,
    recipientTeamId: 4,
    rosterSizes: { 2: 3, 4: 3 }
  });
  assert.equal(ok, true, 'the engine is the one that can refuse it authoritatively');
});

section('the lock, over a whole trade');

const LIVE_TRADE = [
  { senderTeamId: 3, assetType: 'PLAYER', assetId: 'h-11' },  // Josh Jacobs, GB — played
  { senderTeamId: 1, assetType: 'PLAYER', assetId: 'h-08' },  // Jahmyr Gibbs, DET — has not
  { senderTeamId: 1, assetType: 'FAAB', amount: 5 }
];

test('only the players are checked, and only the locked ones come back', () => {
  assert.deepEqual(tradePlayerIds(LIVE_TRADE), ['h-11', 'h-08']);
  const locked = lockedTradePlayers(LIVE_TRADE, PLAYERS, WEEK3, NOW);
  assert.equal(locked.length, 1);
  assert.equal(locked[0].name, 'Josh Jacobs');
  assert.equal(locked[0].reason, 'final');
});

test('a trade with any locked player has to wait', () => {
  assert.equal(tradeMustWait(LIVE_TRADE, PLAYERS, WEEK3, NOW), true);
});

test('a trade of players whose games have not started does not', () => {
  const clear = [
    { senderTeamId: 1, assetType: 'PLAYER', assetId: 'h-08' },
    { senderTeamId: 2, assetType: 'PLAYER', assetId: 'h-07' }
  ];
  assert.equal(tradeMustWait(clear, PLAYERS, WEEK3, NOW), false);
  assert.deepEqual(lockedTradePlayers(clear, PLAYERS, WEEK3, NOW), []);
});

test('the deferral sentence is the one the database writes', () => {
  const one = tradeDeferralMessage(lockedTradePlayers(LIVE_TRADE, PLAYERS, WEEK3, NOW), 4);
  assert.equal(
    one,
    'Josh Jacobs is in a game that has already started; the trade takes effect in week 4.'
  );
  const two = tradeDeferralMessage([{ name: 'Josh Jacobs' }, { name: 'Justin Jefferson' }], 4);
  assert.match(two, /Josh Jacobs and 1 other player\(s\) are in a game/);
  assert.equal(tradeDeferralMessage([], 4), '');
});

test('the slot list and the statuses match the migration', () => {
  assert.equal(ROSTER_SLOTS.length, 15);
  assert.ok(TRADE_STATUSES.includes('PENDING_NEXT_WEEK'));
});

/* =========================================================================
 * 2. The routes
 * ========================================================================= */

function fakeResponse() {
  return {
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader() {
      return this;
    },
    json(body) {
      this.body = body;
    }
  };
}

/**
 * Runs a handler with the Supabase environment faked and `fetch` answering from
 * `rpcs` — a map of RPC name to `{ ok, status, json }` or to a function of the
 * request body. Records the RPCs that were called, in order, which is how the
 * guard-before-write ordering is asserted.
 */
async function call(handler, req, rpcs = {}) {
  const calls = [];
  const previous = {
    fetch: global.fetch,
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    secret: process.env.CRON_SECRET
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  global.fetch = async (url, options) => {
    const name = String(url).split('/rpc/')[1];
    calls.push(name);
    const answer = rpcs[name];
    if (answer === undefined) return { ok: true, status: 200, json: async () => ({}) };
    return typeof answer === 'function' ? answer(JSON.parse(options.body)) : answer;
  };

  const res = fakeResponse();
  try {
    await handler(req, res);
  } finally {
    global.fetch = previous.fetch;
    restore('SUPABASE_URL', previous.url);
    restore('SUPABASE_SERVICE_ROLE_KEY', previous.key);
    restore('CRON_SECRET', previous.secret);
  }
  return { res, calls };
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const refused = (message) => ({
  ok: false,
  status: 400,
  json: async () => ({ code: 'P0001', message })
});
const missing = { ok: false, status: 404, json: async () => ({ code: 'PGRST202' }) };

section('/api/waivers/process');

await asyncTest('a run settles the wire, then the deferred trades, then the expiries', async () => {
  const { res, calls } = await call(
    waiverHandler,
    { method: 'POST', body: {} },
    {
      fsnv2_process_waivers: ok({ awarded: 2 }),
      fsnv2_process_pending_trades: ok({ swept: [] }),
      fsnv2_expire_trades: ok({ expired: [] })
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [
    'fsnv2_process_waivers',
    'fsnv2_process_pending_trades',
    'fsnv2_expire_trades'
  ]);
  assert.deepEqual(res.body.tasks, ['waivers', 'trades', 'expiry']);
  assert.equal(res.body.waivers.awarded, 2);
});

await asyncTest('tasks can be narrowed, and stay in schedule order', async () => {
  const { calls, res } = await call(
    waiverHandler,
    { method: 'POST', body: { tasks: ['expiry', 'waivers'] } },
    { fsnv2_process_waivers: ok({}), fsnv2_expire_trades: ok({}) }
  );
  assert.deepEqual(calls, ['fsnv2_process_waivers', 'fsnv2_expire_trades']);
  assert.deepEqual(res.body.tasks, ['waivers', 'expiry']);
});

await asyncTest('an unknown task is a 400 before anything runs', async () => {
  const { res, calls } = await call(waiverHandler, { method: 'POST', body: { tasks: 'trades,nope' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Unknown task\(s\): nope/);
  assert.deepEqual(calls, []);
});

await asyncTest('the cron secret is required once it is set', async () => {
  process.env.CRON_SECRET = 'shh';
  const { res, calls } = await call(waiverHandler, { method: 'POST', body: {}, headers: {} });
  delete process.env.CRON_SECRET;
  assert.equal(res.statusCode, 401);
  assert.deepEqual(calls, [], 'nothing was processed');
});

await asyncTest('and accepted as a bearer token', async () => {
  process.env.CRON_SECRET = 'shh';
  const { res } = await call(
    waiverHandler,
    { method: 'POST', body: {}, headers: { authorization: 'Bearer shh' } },
    { fsnv2_process_waivers: ok({}), fsnv2_process_pending_trades: ok({}), fsnv2_expire_trades: ok({}) }
  );
  delete process.env.CRON_SECRET;
  assert.equal(res.statusCode, 200);
});

await asyncTest('with no secret configured the run still happens, and says so', async () => {
  const { res } = await call(
    waiverHandler,
    { method: 'POST', body: { tasks: 'waivers' } },
    { fsnv2_process_waivers: ok({}) }
  );
  assert.equal(res.statusCode, 200);
  assert.match(res.body.warning, /CRON_SECRET is not set/);
});

await asyncTest('an invalid league id never reaches the database', async () => {
  const { res, calls } = await call(waiverHandler, { method: 'POST', body: { leagueId: 'nope' } });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(calls, []);
});

await asyncTest('a missing migration is a 503 naming the file', async () => {
  const { res } = await call(
    waiverHandler,
    { method: 'POST', body: { tasks: 'waivers' } },
    { fsnv2_process_waivers: missing }
  );
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /0014_fsnv2_waivers_and_trades\.sql/);
});

await asyncTest('a task that fails reports the tasks that already committed', async () => {
  const { res } = await call(
    waiverHandler,
    { method: 'POST', body: {} },
    {
      fsnv2_process_waivers: ok({ awarded: 1 }),
      fsnv2_process_pending_trades: refused('league has no drafted roster')
    }
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.task, 'trades');
  assert.equal(res.body.ran.waivers.awarded, 1, 'the settled wire is not forgotten');
});

await asyncTest('a preview settles nothing', async () => {
  const { res, calls } = await call(
    waiverHandler,
    { method: 'GET', query: { preview: '1', leagueId: LEAGUE } },
    { fsnv2_waiver_board: ok([{ processing_order: 1, team_id: 3 }]) }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['fsnv2_waiver_board']);
  assert.equal(res.body.board[0].team_id, 3);
});

await asyncTest('and a bare GET is refused rather than silently processing', async () => {
  const { res } = await call(waiverHandler, { method: 'DELETE' });
  assert.equal(res.statusCode, 405);
});

section('/api/trades/propose');

const OFFER = {
  leagueId: LEAGUE,
  proposerTeamId: 1,
  recipientTeamId: 2,
  items: [
    { senderTeamId: 1, assetType: 'PLAYER', assetId: 'h-08' },
    { senderTeamId: 2, assetType: 'PLAYER', assetId: 'h-07' }
  ]
};

await asyncTest('a well-formed offer is inserted and comes back as 201', async () => {
  const { res, calls } = await call(
    proposeHandler,
    { method: 'POST', body: OFFER },
    { fsnv2_propose_trade: ok({ trade_id: TRADE, status: 'PENDING' }) }
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.status, 'PENDING');
  assert.deepEqual(calls, ['fsnv2_propose_trade']);
});

await asyncTest('the items are normalised on the way through', async () => {
  let sent = null;
  await call(
    proposeHandler,
    { method: 'POST', body: { ...OFFER, items: [{ sender_team_id: 1, asset_type: 'player', asset_id: 'h-08' }] } },
    {
      fsnv2_propose_trade: (body) => {
        sent = body;
        return ok({ trade_id: TRADE });
      }
    }
  );
  assert.deepEqual(sent.p_items, [
    { sender_team_id: 1, asset_type: 'PLAYER', asset_id: 'h-08', amount: null }
  ]);
  assert.equal(sent.p_expires_at, null, 'the league default is left to the database');
});

await asyncTest('a malformed item is a 400, not a constraint violation', async () => {
  const { res, calls } = await call(proposeHandler, {
    method: 'POST',
    body: { ...OFFER, items: [{ senderTeamId: 1, assetType: 'PLAYER' }] }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /item 1 is a PLAYER with no asset id/);
  assert.deepEqual(calls, []);
});

await asyncTest('a draft pick is sent as the label, for the engine to resolve', async () => {
  let sent = null;
  const { res } = await call(
    proposeHandler,
    {
      method: 'POST',
      body: {
        ...OFFER,
        items: [{ senderTeamId: 1, assetType: 'DRAFT_PICK', assetId: '2027-R2-T2' }]
      }
    },
    {
      fsnv2_propose_trade: (body) => {
        sent = body;
        return ok({ trade_id: TRADE, status: 'PENDING' });
      }
    }
  );
  assert.equal(res.statusCode, 201);
  assert.deepEqual(sent.p_items, [
    { sender_team_id: 1, asset_type: 'DRAFT_PICK', asset_id: '2027-R2-T2', amount: null }
  ]);
});

await asyncTest('an unreadable pick is a 400 before the database sees it', async () => {
  const { res, calls } = await call(proposeHandler, {
    method: 'POST',
    body: { ...OFFER, items: [{ senderTeamId: 1, assetType: 'DRAFT_PICK', assetId: 'next year' }] }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /cannot read "next year" as a draft pick/);
  assert.deepEqual(calls, []);
});

await asyncTest('a pick the engine refuses comes back as a 409 in its words', async () => {
  const { res } = await call(
    proposeHandler,
    {
      method: 'POST',
      body: { ...OFFER, items: [{ senderTeamId: 1, assetType: 'DRAFT_PICK', assetId: '2027-R2' }] }
    },
    { fsnv2_propose_trade: refused('2027 Round 2 is not Alpha\u2019s pick to trade') }
  );
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /not Alpha\u2019s pick to trade/);
});

await asyncTest('a sender outside the trade is a 400', async () => {
  const { res, calls } = await call(proposeHandler, {
    method: 'POST',
    body: { ...OFFER, items: [{ senderTeamId: 3, assetType: 'PLAYER', assetId: 'h-09' }] }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Team 3 is not part of this trade/);
  assert.deepEqual(calls, []);
});

await asyncTest('trading with yourself is a 400', async () => {
  const { res } = await call(proposeHandler, {
    method: 'POST',
    body: { ...OFFER, recipientTeamId: 1 }
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /cannot trade with itself/);
});

await asyncTest('an ownership refusal from the engine is a 409 in its own words', async () => {
  const { res } = await call(
    proposeHandler,
    { method: 'POST', body: OFFER },
    { fsnv2_propose_trade: refused('Jahmyr Gibbs is not on Alpha’s roster') }
  );
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /not on Alpha’s roster/);
});

section('/api/trades/respond');

await asyncTest('the recipient accepting is a 200', async () => {
  const { res } = await call(
    respondHandler,
    { method: 'POST', body: { tradeId: TRADE, teamId: 2, action: 'accept' } },
    { fsnv2_respond_trade: ok({ status: 'ACCEPTED' }) }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ACCEPTED');
});

await asyncTest('a veto needs no team', async () => {
  let sent = null;
  const { res } = await call(
    respondHandler,
    { method: 'POST', body: { tradeId: TRADE, action: 'VETO' } },
    {
      fsnv2_respond_trade: (body) => {
        sent = body;
        return ok({ status: 'VETOED' });
      }
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(sent.p_team_id, null);
});

await asyncTest('an unknown action never reaches the database', async () => {
  const { res, calls } = await call(respondHandler, {
    method: 'POST',
    body: { tradeId: TRADE, teamId: 2, action: 'SHRUG' }
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(calls, []);
});

await asyncTest('an answer without a team is a 400', async () => {
  const { res } = await call(respondHandler, {
    method: 'POST',
    body: { tradeId: TRADE, action: 'ACCEPT' }
  });
  assert.equal(res.statusCode, 400);
});

await asyncTest('a trade that does not exist is a 404', async () => {
  const { res } = await call(
    respondHandler,
    { method: 'POST', body: { tradeId: TRADE, teamId: 2, action: 'ACCEPT' } },
    {
      fsnv2_respond_trade: {
        ok: false,
        status: 400,
        json: async () => ({ code: 'P0002', message: 'trade not found' })
      }
    }
  );
  assert.equal(res.statusCode, 404);
});

section('/api/trades/execute');

await asyncTest('a clear trade executes, and the lock is checked first', async () => {
  const { res, calls } = await call(
    executeHandler,
    { method: 'POST', body: { tradeId: TRADE } },
    {
      fsnv2_trade_lock_report: ok([]),
      fsnv2_execute_trade: ok({ status: 'EXECUTED', moves: [{ player: { name: 'Jahmyr Gibbs' } }] })
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'EXECUTED');
  assert.deepEqual(calls, ['fsnv2_trade_lock_report', 'fsnv2_execute_trade']);
});

await asyncTest('a trade with a player mid-game comes back 202, held over', async () => {
  const locked = [{ player_id: 'h-11', name: 'Josh Jacobs', team: 'GB' }];
  const { res } = await call(
    executeHandler,
    { method: 'POST', body: { tradeId: TRADE, now: '2026-09-26T12:00:00Z' } },
    {
      fsnv2_trade_lock_report: ok(locked),
      fsnv2_execute_trade: ok({
        status: 'PENDING_NEXT_WEEK',
        effective_week: 4,
        status_detail:
          'Josh Jacobs is in a game that has already started; the trade takes effect in week 4.',
        locked_players: locked
      })
    }
  );
  assert.equal(res.statusCode, 202, 'accepted, not applied');
  assert.equal(res.body.status, 'PENDING_NEXT_WEEK');
  assert.equal(res.body.effective_week, 4);
  assert.equal(res.body.locked_players[0].name, 'Josh Jacobs');
});

await asyncTest('the clock is passed through, so the guard reads the caller’s instant', async () => {
  let sent = null;
  await call(
    executeHandler,
    { method: 'POST', body: { tradeId: TRADE, now: '2026-09-26T12:00:00Z' } },
    {
      fsnv2_trade_lock_report: ok([]),
      fsnv2_execute_trade: (body) => {
        sent = body;
        return ok({ status: 'EXECUTED' });
      }
    }
  );
  assert.equal(sent.p_now, '2026-09-26T12:00:00.000Z');
});

await asyncTest('an unexecutable trade is a 409 in the engine’s words', async () => {
  const { res } = await call(
    executeHandler,
    { method: 'POST', body: { tradeId: TRADE } },
    {
      fsnv2_trade_lock_report: ok([]),
      fsnv2_execute_trade: refused('only an accepted trade can be executed; this one is pending')
    }
  );
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /only an accepted trade/);
});

await asyncTest('a missing lock report stops the swap rather than waving it through', async () => {
  const { res, calls } = await call(
    executeHandler,
    { method: 'POST', body: { tradeId: TRADE } },
    { fsnv2_trade_lock_report: missing }
  );
  assert.equal(res.statusCode, 503);
  assert.deepEqual(calls, ['fsnv2_trade_lock_report', 'fsnv2_trade_lock_report'],
    'the one retry for a stale catalog, and then it stops');
});

await asyncTest('an invalid `now` is a 400', async () => {
  const { res, calls } = await call(executeHandler, {
    method: 'POST',
    body: { tradeId: TRADE, now: 'whenever' }
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(calls, []);
});

/* ----------------------------------------------------------------- report -- */

const failed = results.filter((row) => !row.ok);
console.log(
  `\n\u001b[1m${results.length - failed.length}/${results.length} passed\u001b[0m` +
    (failed.length ? ` — \u001b[31m${failed.length} failed\u001b[0m` : '')
);
if (failed.length) process.exitCode = 1;
