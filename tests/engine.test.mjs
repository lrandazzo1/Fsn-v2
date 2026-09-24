/**
 * Terminal test-suite for the draft engine.
 *   node tests/engine.test.mjs
 *
 * Covers the Phase 1 fixes: snake rotation, on-the-clock indexing, next-up
 * previews, pick-clock expiry auto-picks and state hydration.
 */

import assert from 'node:assert/strict';
import { DraftEngine } from '../js/draftEngine.js';
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
