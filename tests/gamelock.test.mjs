/**
 * Terminal test-suite for the lineup lock.
 *   node tests/gamelock.test.mjs
 *
 * The bug this covers: a lineup could be rearranged at any time, so a manager
 * who had already watched Thursday night's box score could bench the player who
 * produced it — or promote one whose own game was under way. Four things are
 * checked here, in the order they matter:
 *
 *   1. `isPlayerLocked()` gets the boundaries right — before kickoff, at
 *      kickoff, in progress, final, BYE, postponed — and reads every shape a
 *      schedule feed arrives in.
 *   2. the week registry the UI reads, and the kickoff times js/liveData.js
 *      lifts out of the synced schedule rows.
 *   3. `createLineup()` refuses a swap touching a locked player on *either*
 *      side, says why, and leaves the lineup untouched.
 *   4. api/roster/swap.js refuses the same swap with a 400 before the write.
 *
 * The SQL half of the guard (`fsnv2_swap_lineup` in migration 0013) is not
 * exercised here — it needs a database — but it is a deliberate mirror of the
 * same predicate, and the API test below covers the wording both produce.
 */

import assert from 'node:assert/strict';
import { DraftEngine } from '../js/draftEngine.js';
import { createLineup, lockedInSwap, canSwap } from '../js/lineup.js';
import { createLiveData } from '../js/liveData.js';
import swapHandler from '../api/roster/swap.js';
import {
  buildGameSchedule,
  gameStartTimestamp,
  hasLockSchedule,
  isLockedInWeek,
  isPlayerLocked,
  lockScheduleWeeks,
  lockedPlayerMessage,
  normalizeGameStatus,
  playerLockState,
  rosterLocksInWeek,
  setLockSchedule
} from '../js/gameLock.js';

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

/** Week 3 of 2026: a Thursday night game and a Sunday afternoon one. */
const THURSDAY = Date.parse('2026-09-24T00:15:00Z');
const SUNDAY = Date.parse('2026-09-27T17:00:00Z');

/** Tank01's getNFLGamesForWeek shape, as lib/fixtures/tank01 records it. */
const TANK01_WEEK = [
  {
    gameID: '20260924_GB@ARI',
    gameWeek: 'Week 3',
    away: 'GB',
    home: 'ARI',
    gameDate: '20260924',
    gameTime: '8:15p',
    gameTime_epoch: String(THURSDAY / 1000),
    gameStatus: 'Scheduled'
  },
  {
    gameID: '20260927_MIA@NE',
    gameWeek: 'Week 3',
    away: 'MIA',
    home: 'NE',
    gameDate: '20260927',
    gameTime: '1:00p',
    gameTime_epoch: String(SUNDAY / 1000),
    gameStatus: 'Scheduled'
  }
];

const packer = { name: 'Josh Jacobs', teamAbv: 'GB', position: 'RB' };
const dolphin = { name: 'Tyreek Hill', teamAbv: 'MIA', position: 'WR' };
/** A team with no game in the payload: a BYE. */
const byeWeek = { name: 'Bijan Robinson', teamAbv: 'ATL', position: 'RB' };

/* =========================================================================
 * 1. the predicate
 * ======================================================================= */

section('1. isPlayerLocked()');

test('a game that has not kicked off yet leaves the player movable', () => {
  const now = THURSDAY - 60_000;
  assert.equal(isPlayerLocked(packer, TANK01_WEEK, now), false);
  assert.equal(playerLockState(packer, TANK01_WEEK, now).reason, 'scheduled');
});

test('kickoff itself locks the player', () => {
  assert.equal(isPlayerLocked(packer, TANK01_WEEK, THURSDAY - 1), false, 'one ms before');
  assert.equal(isPlayerLocked(packer, TANK01_WEEK, THURSDAY), true, 'now >= kickoff');
  assert.equal(isPlayerLocked(packer, TANK01_WEEK, THURSDAY + 1), true, 'one ms after');
  assert.equal(playerLockState(packer, TANK01_WEEK, THURSDAY).reason, 'started');
});

test("one team's kickoff does not lock another team's players", () => {
  // The whole point: Thursday night is over, Sunday has not started.
  const now = THURSDAY + 3 * 3600_000;
  assert.equal(isPlayerLocked(packer, TANK01_WEEK, now), true);
  assert.equal(isPlayerLocked(dolphin, TANK01_WEEK, now), false);
});

test('both sides of a game are locked, home and away', () => {
  assert.equal(isPlayerLocked({ name: 'Trey McBride', teamAbv: 'ARI' }, TANK01_WEEK, THURSDAY), true);
});

test("'In Progress', 'Completed' and 'Final' lock regardless of the clock", () => {
  const before = THURSDAY - 86_400_000;
  for (const status of ['In Progress', 'Completed', 'Final', 'Final/OT', 'Halftime', 'live']) {
    const games = [{ ...TANK01_WEEK[0], gameStatus: status }];
    assert.equal(isPlayerLocked(packer, games, before), true, `${status} should lock`);
  }
});

test('a BYE is never locked', () => {
  assert.equal(isPlayerLocked(byeWeek, TANK01_WEEK, SUNDAY + 86_400_000), false);
  assert.equal(playerLockState(byeWeek, TANK01_WEEK, SUNDAY).reason, 'bye');
  assert.equal(isPlayerLocked({ name: 'Nobody', team: 'FA' }, TANK01_WEEK, SUNDAY), false);
});

test('a postponed or canceled game does not lock, even after kickoff passes', () => {
  for (const status of ['Postponed', 'Canceled', 'Suspended']) {
    const games = [{ ...TANK01_WEEK[0], gameStatus: status }];
    assert.equal(isPlayerLocked(packer, games, THURSDAY + 86_400_000), false, status);
  }
});

test('a game with neither kickoff nor status locks nobody', () => {
  const state = playerLockState(packer, [{ gameID: 'x', home: 'ARI', away: 'GB' }], Date.now());
  assert.equal(state.locked, false);
  assert.equal(state.reason, 'unknown');
});

test('the refusal reads the same everywhere', () => {
  assert.equal(
    lockedPlayerMessage(packer),
    'Cannot move player: Josh Jacobs is locked because their game has already started.'
  );
});

section('2. feed shapes');

test('gameTimeEpoch is read in seconds, in millis, and as a string', () => {
  assert.equal(gameStartTimestamp({ gameTime_epoch: '1789344900.0' }), 1789344900000);
  assert.equal(gameStartTimestamp({ gameTimeEpoch: 1789344900 }), 1789344900000);
  assert.equal(gameStartTimestamp({ kickoff_epoch: 1789344900000 }), 1789344900000);
  // Sleeper sends millis under start_time.
  assert.equal(gameStartTimestamp({ start_time: 1789344900000 }), 1789344900000);
  assert.equal(gameStartTimestamp({ gameTimeEpoch: 42 }), null, 'nonsense is not a date');
});

test('an ISO kickoff and our own nfl_matchups shape are read', () => {
  assert.equal(gameStartTimestamp({ kickoff: '2026-09-24T00:15:00Z' }), THURSDAY);
  assert.equal(gameStartTimestamp({ gameTimeISO: '2026-09-24T00:15:00.000Z' }), THURSDAY);
  const rows = [
    { home_team: 'ARI', away_team: 'GB', kickoff: '2026-09-24T00:15:00+00:00', status: 'final' }
  ];
  assert.equal(isPlayerLocked(packer, rows, THURSDAY - 86_400_000), true);
});

test('gameDate + gameTime are read as US Eastern', () => {
  assert.equal(gameStartTimestamp({ gameDate: '20260927', gameTime: '1:00p' }), SUNDAY);
  // Late November is EST, so 1:00p Eastern is 18:00 UTC.
  assert.equal(
    gameStartTimestamp({ gameDate: '2026-11-22', gameTime: '1:00p' }),
    Date.parse('2026-11-22T18:00:00Z')
  );
  assert.equal(
    gameStartTimestamp({ gameDate: '20260927', gameTime: '12:00a' }),
    Date.parse('2026-09-27T04:00:00Z')
  );
});

test('a payload is read as an array, a Tank01 envelope or a keyed object', () => {
  const expected = buildGameSchedule(TANK01_WEEK).byTeam.size;
  assert.equal(buildGameSchedule({ statusCode: 200, body: TANK01_WEEK }).byTeam.size, expected);
  assert.equal(buildGameSchedule({ games: TANK01_WEEK }).byTeam.size, expected);
  assert.equal(
    buildGameSchedule(Object.fromEntries(TANK01_WEEK.map((game) => [game.gameID, game]))).byTeam.size,
    expected
  );
  assert.equal(buildGameSchedule(null).games.length, 0);
  assert.equal(isPlayerLocked(packer, [], Date.now()), false, 'no schedule, no locks');
});

test("a player's team is read from teamAbv, team or nflTeam", () => {
  for (const player of [{ teamAbv: 'GB' }, { team: 'GB' }, { nflTeam: 'gb' }]) {
    assert.equal(isPlayerLocked(player, TANK01_WEEK, THURSDAY), true, JSON.stringify(player));
  }
});

test('vendor status spellings normalise to our five', () => {
  assert.equal(normalizeGameStatus('Completed'), 'final');
  assert.equal(normalizeGameStatus('In Progress'), 'in_progress');
  assert.equal(normalizeGameStatus('2nd Quarter'), 'in_progress');
  assert.equal(normalizeGameStatus('Not Started'), 'scheduled');
  assert.equal(normalizeGameStatus('pre_game'), 'scheduled');
  assert.equal(normalizeGameStatus(''), null);
});

/* =========================================================================
 * 3. the synced schedule behind it
 * ======================================================================= */

section('3. the synced week');

test('kickoffs and statuses are lifted out of fsnv2_nfl_schedule rows', () => {
  const live = createLiveData({
    schedule: [
      {
        external_id: '20260924_GB@ARI',
        week: 3,
        home_team: 'ARI',
        away_team: 'GB',
        kickoff: '2026-09-24T00:15:00Z',
        status: 'final'
      },
      {
        external_id: '20260927_MIA@NE',
        week: 3,
        home_team: 'NE',
        away_team: 'MIA',
        kickoff: '2026-09-27T17:00:00Z',
        status: 'scheduled'
      }
    ]
  });

  const games = live.gamesByWeek.get(3);
  assert.equal(games.length, 2);
  assert.equal(games[0].kickoff, THURSDAY);
  assert.equal(games[0].status, 'final');
  // The opponent slate the rest of the UI reads is untouched by any of this.
  assert.deepEqual(live.slate.get(3).GB, { opponent: 'ARI', home: false });
});

test('the registry answers per week, and only for weeks it was given', () => {
  assert.equal(setLockSchedule(new Map([[3, TANK01_WEEK]])), 1);
  assert.deepEqual(lockScheduleWeeks(), [3]);
  assert.equal(hasLockSchedule(3), true);
  assert.equal(isLockedInWeek(packer, 3, THURSDAY + 1), true);
  assert.equal(isLockedInWeek(dolphin, 3, THURSDAY + 1), false);

  // A week the sync has not stored is unknown, and locks nobody — no fixture is
  // ever inferred, the same posture js/nflTeams.js takes with '—'.
  assert.equal(hasLockSchedule(4), false);
  assert.equal(isLockedInWeek(packer, 4, THURSDAY + 1), false);

  assert.equal(setLockSchedule(null), 0);
  assert.equal(isLockedInWeek(packer, 3, THURSDAY + 1), false, 'no schedule, no locks');
});

/* =========================================================================
 * 4. the swap guard
 * ======================================================================= */

section('4. the lineup manager');

const manualScheduler = { setInterval: () => 1, clearInterval: () => {} };

/** A drafted league whose week 3 is the fixture above, an hour into Thursday. */
function lockedLeague({ now = THURSDAY + 3600_000 } = {}) {
  const engine = new DraftEngine({ scheduler: manualScheduler });
  engine.autoDraftUser = true;
  engine.simulateAll();
  setLockSchedule(new Map([[3, TANK01_WEEK]]));

  const teamId = engine.userTeamId;
  const roster = engine.rosterFor(teamId);
  // Two real players on the roster: one whose game is under way, one whose is
  // not, in slots that can legally trade places.
  engine.playersById[roster.WR1].team = 'GB';
  engine.playersById[roster.WR1].name = 'Josh Jacobs';
  engine.playersById[roster.WR2].team = 'MIA';
  engine.playersById[roster.WR2].name = 'Tyreek Hill';
  // A movable bench receiver, so there is a legal pair to swap as well as an
  // illegal one: the bench takes anyone, WR2 only takes a WR.
  engine.playersById[roster.BN1].team = 'MIA';
  engine.playersById[roster.BN1].position = 'WR';
  engine.playersById[roster.BN1].name = 'Jaylen Waddle';

  const notices = [];
  const lineup = createLineup({
    engine,
    teamId,
    persist: () => Promise.resolve({ roster: engine.rosterFor(teamId), version: 1 }),
    notify: (message) => notices.push(message),
    onChange: () => {},
    week: () => 3,
    now: () => now
  });
  return { engine, teamId, roster, lineup, notices };
}

test('a locked player cannot be picked up', () => {
  const { lineup, notices } = lockedLeague();
  lineup.select('WR1');
  assert.equal(lineup.selectedSlot, null, 'nothing was picked up');
  assert.match(notices.at(-1), /Josh Jacobs is locked because their game has already started/);
});

test('a locked player cannot be swapped into either', () => {
  const { engine, teamId, roster, lineup, notices } = lockedLeague();
  const before = { ...engine.rosterFor(teamId) };
  lineup.select('WR2'); // movable
  assert.equal(lineup.selectedSlot, 'WR2');
  lineup.select('WR1'); // locked destination
  assert.match(notices.at(-1), /Josh Jacobs is locked/);
  assert.deepEqual(engine.rosterFor(teamId), before, 'the lineup is untouched');
  assert.equal(roster.WR1, before.WR1);
});

test('a locked slot is never offered as a target', () => {
  const { lineup } = lockedLeague();
  lineup.select('WR2');
  assert.equal(lineup.validTarget('WR1'), false, 'the locked starter is not a target');
  assert.equal(lineup.lockedSlot('WR1'), true);
  assert.equal(lineup.lockedSlot('WR2'), false);
});

test('two movable players still swap', () => {
  const { engine, teamId, lineup } = lockedLeague();
  const before = { ...engine.rosterFor(teamId) };
  lineup.select('WR2');
  assert.equal(lineup.validTarget('BN1'), true, 'an unlocked receiver is a target');
  lineup.select('BN1');
  const after = engine.rosterFor(teamId);
  assert.equal(after.WR2, before.BN1);
  assert.equal(after.BN1, before.WR2);
});

test('before kickoff the same swap is allowed', () => {
  const { engine, teamId, lineup } = lockedLeague({ now: THURSDAY - 60_000 });
  const before = { ...engine.rosterFor(teamId) };
  lineup.select('WR1');
  lineup.select('WR2');
  const after = engine.rosterFor(teamId);
  assert.equal(after.WR1, before.WR2);
  assert.equal(after.WR2, before.WR1);
});

test('canSwap() only applies the lock when it is given a week', () => {
  const { engine, teamId } = lockedLeague();
  const roster = engine.rosterFor(teamId);
  const players = engine.playersById;
  // Positional legality alone — how the draft room's read-only rows ask.
  assert.equal(canSwap(roster, players, 'WR1', 'WR2'), true);
  // With the week, the started game is taken into account.
  assert.equal(canSwap(roster, players, 'WR1', 'WR2', 3, THURSDAY + 1), false);
  assert.equal(canSwap(roster, players, 'WR1', 'WR2', 3, THURSDAY - 1), true);

  const blocked = lockedInSwap(roster, players, 'WR1', 'WR2', 3, THURSDAY + 1);
  assert.equal(blocked.name, 'Josh Jacobs');
});

test('the roster lock map flags exactly the started players', () => {
  const { engine, teamId } = lockedLeague();
  const locks = rosterLocksInWeek(
    engine.rosterFor(teamId),
    engine.playersById,
    3,
    THURSDAY + 1
  );
  assert.equal(locks.get('WR1').locked, true);
  assert.equal(locks.get('WR1').team, 'GB');
  assert.equal(locks.get('WR2').locked, false);
});

/* =========================================================================
 * 5. the endpoint
 * ======================================================================= */

section('5. api/roster/swap.js');

const DRAFT = '12345678-1234-1234-1234-123456789abc';

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

async function callSwap({ locked = [], onSwap = null } = {}) {
  const calls = [];
  const previous = { fetch: global.fetch, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  global.fetch = async (url, options) => {
    calls.push(url.split('/rpc/')[1]);
    if (/fsnv2_locked_players$/.test(url)) {
      return { ok: true, json: async () => locked };
    }
    return onSwap
      ? onSwap(JSON.parse(options.body))
      : { ok: true, json: async () => ({ roster: {}, version: 1 }) };
  };

  const res = fakeResponse();
  await swapHandler(
    {
      method: 'POST',
      body: {
        draftId: DRAFT,
        teamId: 1,
        from: 'WR1',
        to: 'BN1',
        fromPlayerId: 'p-0001',
        toPlayerId: 'p-0002',
        expectedVersion: 0
      }
    },
    res
  );

  global.fetch = previous.fetch;
  if (previous.url === undefined) delete process.env.SUPABASE_URL;
  else process.env.SUPABASE_URL = previous.url;
  if (previous.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.key;

  return { res, calls };
}

await asyncTest('a swap with neither player playing is written', async () => {
  const { res, calls } = await callSwap();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['fsnv2_locked_players', 'fsnv2_swap_lineup']);
});

await asyncTest('a locked player is a 400, and never reaches the write', async () => {
  const { res, calls } = await callSwap({
    locked: [{ player_id: 'p-0001', name: 'Josh Jacobs', team: 'GB' }]
  });
  assert.equal(res.statusCode, 400);
  assert.equal(
    res.body.error,
    'Cannot move player: Josh Jacobs is locked because their game has already started.'
  );
  assert.deepEqual(calls, ['fsnv2_locked_players'], 'the mutation was never attempted');
});

await asyncTest('the database refusing inside the write is also a 400', async () => {
  // A kickoff that lands between the guard and the swap: fsnv2_swap_lineup
  // re-checks it in the same transaction, and that refusal is a client error.
  const { res } = await callSwap({
    onSwap: () => ({
      ok: false,
      status: 400,
      json: async () => ({
        code: 'P0001',
        message: 'Cannot move player: Tyreek Hill is locked because their game has already started.'
      })
    })
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Tyreek Hill is locked/);
});

/* ----------------------------------------------------------------- report -- */

const failed = results.filter((row) => !row.ok);
console.log(
  `\n\u001b[1m${results.length - failed.length}/${results.length} passed\u001b[0m` +
    (failed.length ? ` — \u001b[31m${failed.length} failed\u001b[0m` : '')
);
if (failed.length) process.exitCode = 1;
