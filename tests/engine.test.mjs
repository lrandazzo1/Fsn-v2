/**
 * Terminal test-suite for the draft engine.
 *   node tests/engine.test.mjs
 *
 * Covers the Phase 1 fixes: snake rotation, on-the-clock indexing, next-up
 * previews, pick-clock expiry auto-picks and state hydration.
 */

import assert from 'node:assert/strict';
import {
  DraftEngine,
  snakePickNumber,
  snakeTeamId,
  snakeTeamIndex
} from '../js/draftEngine.js';
import { PickTimer } from '../js/draftTimer.js';

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

/** A scheduler that never fires on its own — tests drive `timer.tick()`. */
const manualScheduler = { setInterval: () => 1, clearInterval: () => {} };

function newEngine(options = {}) {
  return new DraftEngine({ scheduler: manualScheduler, ...options });
}

console.log('\n\u001b[1mFSN v2 — draft engine\u001b[0m\n');

/* ------------------------------------------------------------ snake order -- */

console.log('Snake rotation');

test('round 1 runs teams 1 -> 12', () => {
  const engine = newEngine();
  const round1 = Array.from({ length: 12 }, (_, i) => engine.teamIdForPick(i + 1));
  assert.deepEqual(round1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('round 2 reverses: teams 12 -> 1', () => {
  const engine = newEngine();
  const round2 = Array.from({ length: 12 }, (_, i) => engine.teamIdForPick(13 + i));
  assert.deepEqual(round2, [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test('round 3 runs teams 1 -> 12 again', () => {
  const engine = newEngine();
  const round3 = Array.from({ length: 12 }, (_, i) => engine.teamIdForPick(25 + i));
  assert.deepEqual(round3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

test('turn ends of rounds double back (picks 12/13 and 24/25)', () => {
  const engine = newEngine();
  assert.equal(engine.teamIdForPick(12), 12);
  assert.equal(engine.teamIdForPick(13), 12);
  assert.equal(engine.teamIdForPick(24), 1);
  assert.equal(engine.teamIdForPick(25), 1);
});

test('every team gets exactly one pick per round across all 15 rounds', () => {
  const engine = newEngine();
  for (let round = 1; round <= 15; round += 1) {
    const teams = Array.from({ length: 12 }, (_, i) => engine.teamIdForPick((round - 1) * 12 + i + 1));
    assert.deepEqual([...teams].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  }
});

test('last pick of a 12x15 draft belongs to team 12', () => {
  const engine = newEngine();
  assert.equal(engine.totalPicks, 180);
  assert.equal(engine.teamIdForPick(180), 12);
});

test('snake math holds for an odd team count (11 teams)', () => {
  const engine = newEngine({ teamCount: 11 });
  assert.equal(engine.teamIdForPick(11), 11);
  assert.equal(engine.teamIdForPick(12), 11);
  assert.equal(engine.teamIdForPick(22), 1);
  assert.equal(engine.teamIdForPick(23), 1);
});

test('team 1 owns picks 1, 24, 25 and 48 through round 4', () => {
  const engine = newEngine();
  const owned = Array.from({ length: 48 }, (_, i) => i + 1).filter(
    (overall) => engine.teamIdForPick(overall) === 1
  );
  assert.deepEqual(owned, [1, 24, 25, 48]);
});

test('team 12 owns picks 12, 13, 36 and 37 through round 4', () => {
  const engine = newEngine();
  const owned = Array.from({ length: 48 }, (_, i) => i + 1).filter(
    (overall) => engine.teamIdForPick(overall) === 12
  );
  assert.deepEqual(owned, [12, 13, 36, 37]);
});

test('snakeTeamIndex returns 0-based indexes matching the spec', () => {
  assert.equal(snakeTeamIndex(1, 12), 0);    // R1 pick 1  -> team 1
  assert.equal(snakeTeamIndex(12, 12), 11);  // R1 pick 12 -> team 12
  assert.equal(snakeTeamIndex(13, 12), 11);  // R2 pick 13 -> team 12
  assert.equal(snakeTeamIndex(24, 12), 0);   // R2 pick 24 -> team 1
  assert.equal(snakeTeamIndex(25, 12), 0);   // R3 pick 25 -> team 1
  assert.equal(snakeTeamIndex(48, 12), 0);   // R4 pick 48 -> team 1
  assert.equal(snakeTeamId(13, 12), 12);
});

test('linear drafts never reverse', () => {
  assert.equal(snakeTeamId(13, 12, 'linear'), 1);
  assert.equal(snakeTeamId(24, 12, 'linear'), 12);
});

test('snakePickNumber is the exact inverse of snakeTeamId', () => {
  assert.equal(snakePickNumber(1, 1, 12), 1);
  assert.equal(snakePickNumber(2, 12, 12), 13);
  assert.equal(snakePickNumber(2, 1, 12), 24);
  assert.equal(snakePickNumber(3, 1, 12), 25);
  assert.equal(snakePickNumber(4, 1, 12), 48);

  for (let overall = 1; overall <= 180; overall += 1) {
    const round = Math.ceil(overall / 12);
    const teamId = snakeTeamId(overall, 12);
    assert.equal(snakePickNumber(round, teamId, 12), overall, `pick ${overall}`);
  }
});

/* ------------------------------------------------------- board matrix ----- */

console.log('\nBoard matrix (team columns)');

test('round 2 runs pick 13 at column 12 down to pick 24 at column 1', () => {
  const engine = newEngine();
  const row = Array.from({ length: 12 }, (_, i) => engine.pickNumberFor(2, i + 1));
  assert.deepEqual(row, [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13]);
});

test('odd rounds run left to right in the same grid', () => {
  const engine = newEngine();
  assert.deepEqual(
    Array.from({ length: 12 }, (_, i) => engine.pickNumberFor(1, i + 1)),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  );
  assert.deepEqual(
    Array.from({ length: 12 }, (_, i) => engine.pickNumberFor(3, i + 1)),
    [25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]
  );
});

test('every board cell belongs to the team whose column it sits in', () => {
  const engine = newEngine();
  for (let round = 1; round <= engine.rounds; round += 1) {
    for (let teamId = 1; teamId <= engine.teamCount; teamId += 1) {
      const overall = engine.pickNumberFor(round, teamId);
      assert.equal(engine.teamIdForPick(overall), teamId, `R${round} col ${teamId}`);
    }
  }
});

test('the board matrix covers every pick exactly once', () => {
  const engine = newEngine();
  const cells = [];
  for (let round = 1; round <= engine.rounds; round += 1) {
    for (let teamId = 1; teamId <= engine.teamCount; teamId += 1) {
      cells.push(engine.pickNumberFor(round, teamId));
    }
  }
  assert.equal(new Set(cells).size, engine.totalPicks);
  assert.deepEqual([...cells].sort((a, b) => a - b), Array.from({ length: 180 }, (_, i) => i + 1));
});

test('pickForTeam finds the selection sitting in each column', () => {
  const engine = newEngine();
  engine.autoDraftUser = true;
  for (let i = 0; i < 48; i += 1) engine.autoPick();

  for (let round = 1; round <= 4; round += 1) {
    for (let teamId = 1; teamId <= 12; teamId += 1) {
      const pick = engine.pickForTeam(round, teamId);
      assert.ok(pick, `R${round} team ${teamId} should have a pick`);
      assert.equal(pick.teamId, teamId);
      assert.equal(pick.round, round);
      assert.equal(pick.overall, engine.pickNumberFor(round, teamId));
    }
  }
  assert.deepEqual(
    [1, 2, 3, 4].map((round) => engine.pickForTeam(round, 1).overall),
    [1, 24, 25, 48]
  );
});

/* -------------------------------------------------------- on the clock ----- */

console.log('\nOn-the-clock indexing');

test('round / slot / team advance with every pick', () => {
  const engine = newEngine();
  assert.deepEqual(
    [engine.currentPick, engine.currentRound, engine.currentSlot, engine.currentTeamId],
    [1, 1, 1, 1]
  );

  for (let i = 0; i < 11; i += 1) engine.autoPick();
  assert.deepEqual(
    [engine.currentPick, engine.currentRound, engine.currentSlot, engine.currentTeamId],
    [12, 1, 12, 12]
  );

  engine.autoPick(); // pick 12 -> wraps into round 2, same team picks back-to-back
  assert.deepEqual(
    [engine.currentPick, engine.currentRound, engine.currentSlot, engine.currentTeamId],
    [13, 2, 1, 12]
  );
});

test('picksUntilTurn counts the wrap correctly for the turn team', () => {
  const engine = newEngine({ userTeamId: 12 });
  assert.equal(engine.picksUntilTurn(12), 11);
  for (let i = 0; i < 11; i += 1) engine.autoPick();
  assert.equal(engine.picksUntilTurn(12), 0); // on the clock for pick 12
  engine.autoPick();
  assert.equal(engine.picksUntilTurn(12), 0); // and again for pick 13
});

test('nextUp previews follow snake order and flag the user', () => {
  const engine = newEngine({ userTeamId: 3 });
  const preview = engine.nextUp(4).map((row) => row.teamId);
  assert.deepEqual(preview, [2, 3, 4, 5]);
  assert.equal(engine.nextUp(4).find((row) => row.teamId === 3).isUser, true);

  for (let i = 0; i < 10; i += 1) engine.autoPick(); // on pick 11
  const wrap = engine.nextUp(3);
  assert.deepEqual(wrap.map((row) => row.overall), [12, 13, 14]);
  assert.deepEqual(wrap.map((row) => row.teamId), [12, 12, 11]);
  assert.deepEqual(wrap.map((row) => row.round), [1, 2, 2]);
});

test('nextUp is empty at the final pick', () => {
  const engine = newEngine();
  engine.autoDraftUser = true;
  engine.simulateAll();
  assert.equal(engine.nextUp(3).length, 0);
});

/* ------------------------------------------------ simulation / auto-pick -- */

console.log('\nSimulation and auto-pick routing');

test('Simulate Round fills one roster slot per team, in snake order', () => {
  const engine = newEngine();
  engine.autoDraftUser = true;

  engine.simulateRound(); // round 1
  engine.teams.forEach((team) => assert.equal(team.roster.length, 1, team.name));

  engine.simulateRound(); // round 2
  engine.teams.forEach((team) => assert.equal(team.roster.length, 2, team.name));

  // Each team's round-2 player must be the one taken at its snake pick number.
  engine.teams.forEach((team) => {
    const overall = engine.pickNumberFor(2, team.id);
    const pick = engine.picks.find((p) => p.overall === overall);
    assert.equal(pick.teamId, team.id);
    assert.ok(team.roster.includes(pick.playerId), `${team.name} should hold pick ${overall}`);
  });
});

test('simulating through round 4 routes picks 1/24/25/48 to team 1', () => {
  const engine = newEngine();
  engine.autoDraftUser = true;
  for (let round = 1; round <= 4; round += 1) engine.simulateRound();

  assert.equal(engine.picks.length, 48);
  engine.teams.forEach((team) => assert.equal(team.roster.length, 4, team.name));

  const teamOne = engine.teamById(1);
  const expected = [1, 24, 25, 48].map(
    (overall) => engine.picks.find((pick) => pick.overall === overall).playerId
  );
  assert.deepEqual(teamOne.roster, expected);

  // ...and team 12 holds the back-to-back turn picks.
  const teamTwelve = engine.teamById(12);
  const expected12 = [12, 13, 36, 37].map(
    (overall) => engine.picks.find((pick) => pick.overall === overall).playerId
  );
  assert.deepEqual(teamTwelve.roster, expected12);
});

test('Sim To My Pick stops on the user pick in every round', () => {
  const engine = newEngine({ userTeamId: 5 });

  engine.advanceToUser();
  assert.equal(engine.currentPick, 5, 'round 1 stop');
  assert.equal(engine.isUserOnClock, true);
  engine.autoPick({ source: 'manual' });

  engine.advanceToUser();
  assert.equal(engine.currentPick, 20, 'round 2 stop (12 - 5 + 1 = 8th slot)');
  assert.equal(engine.currentTeamId, 5);
  engine.autoPick({ source: 'manual' });

  engine.advanceToUser();
  assert.equal(engine.currentPick, 29, 'round 3 stop');
  assert.equal(engine.currentTeamId, 5);
});

/* ------------------------------------------------------------- pick clock -- */

console.log('\nPick clock');

test('timer counts down and fires onExpire exactly once', () => {
  let expiries = 0;
  const ticks = [];
  const timer = new PickTimer({
    seconds: 3,
    scheduler: manualScheduler,
    onTick: (remaining) => ticks.push(remaining),
    onExpire: () => { expiries += 1; }
  });
  timer.start();
  timer.tick();
  timer.tick();
  timer.tick();
  timer.tick(); // extra tick after expiry must be a no-op
  assert.deepEqual(ticks, [3, 2, 1, 0]);
  assert.equal(expiries, 1);
  assert.equal(timer.running, false);
});

test('display and fraction format for the UI', () => {
  const timer = new PickTimer({ seconds: 90, scheduler: manualScheduler }).start();
  assert.equal(timer.display, '1:30');
  assert.equal(timer.fraction, 1);
  timer.tick();
  assert.equal(timer.display, '1:29');
});

test('clock expiry drafts the best available player by ADP', () => {
  const engine = newEngine({ timerSeconds: 5 });
  engine.startClock();

  const expected = engine.bestAvailableByAdp();
  const bestAdp = Math.min(...engine.availablePlayers.map((p) => p.adp));
  assert.equal(expected.adp, bestAdp, 'best-by-ADP should be the lowest ADP number left');

  engine.clock.expireNow();

  assert.equal(engine.picks.length, 1);
  assert.equal(engine.picks[0].playerId, expected.id);
  assert.equal(engine.picks[0].source, 'timer_expiry');
  assert.equal(engine.picks[0].auto, true);
});

test('expiry advances the turn cleanly and restarts the clock', () => {
  const engine = newEngine({ timerSeconds: 4 });
  engine.startClock();
  engine.clock.expireNow();

  assert.equal(engine.currentPick, 2);
  assert.equal(engine.currentTeamId, 2);
  assert.equal(engine.clock.running, true, 'clock should restart for the next team');
  assert.equal(engine.clock.remaining, 4, 'clock should be back to a full pick');
});

test('expiry emits an `expire` event carrying the pick', () => {
  const engine = newEngine({ timerSeconds: 2 });
  let seen = null;
  engine.on('expire', (payload) => { seen = payload; });
  engine.startClock();
  engine.clock.tick();
  engine.clock.tick();
  assert.ok(seen?.pick, 'expire event should include the pick');
  assert.equal(seen.pick.overall, 1);
});

test('back-to-back expiries never double-draft a player', () => {
  const engine = newEngine({ timerSeconds: 1 });
  engine.startClock();
  for (let i = 0; i < 24; i += 1) engine.clock.expireNow();
  const ids = engine.picks.map((pick) => pick.playerId);
  assert.equal(ids.length, 24);
  assert.equal(new Set(ids).size, 24);
  assert.deepEqual(
    engine.picks.map((pick) => pick.teamId).slice(0, 13),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12]
  );
});

test('a manual pick restarts a running clock', () => {
  const engine = newEngine({ timerSeconds: 10 });
  engine.startClock();
  engine.clock.tick();
  engine.clock.tick();
  assert.equal(engine.clock.remaining, 8);
  engine.makePick(engine.bestAvailableByAdp().id);
  assert.equal(engine.clock.remaining, 10);
});

test('the clock stops when the draft completes', () => {
  const engine = newEngine({ rounds: 1, timerSeconds: 3 });
  engine.autoDraftUser = true;
  engine.startClock();
  engine.simulateAll();
  assert.equal(engine.complete, true);
  assert.equal(engine.clock.running, false);
});

/* ---------------------------------------------------------- full 15 rounds - */

console.log('\nFull 15-round simulation');

const sim = newEngine();
sim.autoDraftUser = true;
sim.simulateAll();

test('180 picks are made and the draft reports complete', () => {
  assert.equal(sim.picks.length, 180);
  assert.equal(sim.complete, true);
});

test('pick numbers are contiguous 1..180', () => {
  assert.deepEqual(
    sim.picks.map((pick) => pick.overall),
    Array.from({ length: 180 }, (_, i) => i + 1)
  );
});

test('every stored pick matches the snake formula', () => {
  sim.picks.forEach((pick) => {
    assert.equal(pick.teamId, sim.teamIdForPick(pick.overall), `pick ${pick.overall}`);
    assert.equal(pick.round, Math.floor((pick.overall - 1) / 12) + 1);
  });
});

test('no player is drafted twice', () => {
  const ids = sim.picks.map((pick) => pick.playerId);
  assert.equal(new Set(ids).size, 180);
});

test('every team ends with 15 players and zero empty roster slots', () => {
  sim.teams.forEach((team) => {
    assert.equal(team.roster.length, 15, team.name);
    const empty = Object.values(sim.rosterFor(team.id)).filter((slot) => slot === null);
    assert.equal(empty.length, 0, `${team.name} has ${empty.length} empty slots`);
  });
});

test('every team fields a legal starting lineup', () => {
  sim.teams.forEach((team) => {
    const counts = sim.positionCounts(team.id);
    assert.ok(counts.QB >= 1, `${team.name} QB`);
    assert.ok(counts.RB >= 2, `${team.name} RB`);
    assert.ok(counts.WR >= 2, `${team.name} WR`);
    assert.ok(counts.TE >= 1, `${team.name} TE`);
    assert.equal(counts.K, 1, `${team.name} K`);
    assert.equal(counts.DST, 1, `${team.name} DST`);
  });
});

/* ------------------------------------------------------- undo + hydration -- */

console.log('\nUndo and hydration');

test('undo rewinds the board and frees the player', () => {
  const engine = newEngine();
  engine.autoPick();
  engine.autoPick();
  const last = engine.picks[engine.picks.length - 1];
  engine.undo();
  assert.equal(engine.currentPick, last.overall);
  assert.equal(engine.playersById[last.playerId].draftedBy, null);
  assert.equal(engine.picks.length, 1);
});

test('hydrate replays a persisted pick list onto a fresh board', () => {
  const snapshot = sim.toJSON();
  const restored = newEngine();
  const applied = restored.hydrate(snapshot.picks);

  assert.equal(applied, 180);
  assert.equal(restored.complete, true);
  assert.deepEqual(
    restored.picks.map((pick) => pick.playerId),
    sim.picks.map((pick) => pick.playerId)
  );
  assert.deepEqual(
    restored.picks.map((pick) => pick.teamId),
    sim.picks.map((pick) => pick.teamId)
  );
});

test('hydrate handles out-of-order rows by sorting on pick_number', () => {
  const rows = [...sim.toJSON().picks].reverse();
  const restored = newEngine();
  restored.hydrate(rows);
  assert.equal(restored.picks.length, 180);
  assert.equal(restored.picks[0].overall, 1);
});

/* ------------------------------------------------------------------ report */

const failed = results.filter((r) => !r.ok);
console.log(
  `\n\u001b[1m${results.length - failed.length}/${results.length} passed\u001b[0m` +
    (failed.length ? ` — \u001b[31m${failed.length} failed\u001b[0m\n` : '\n')
);
process.exit(failed.length ? 1 : 0);
