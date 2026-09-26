import assert from 'node:assert/strict';
import { canSwap, createLineup, swapRoster, validLineup } from '../js/lineup.js';
import { DraftEngine } from '../js/draftEngine.js';
import { SeasonEngine } from '../js/seasonEngine.js';

const engine = new DraftEngine();
engine.autoDraftUser = true;
engine.simulateAll();
const teamId = engine.userTeamId;
const roster = engine.rosterFor(teamId);
const players = engine.playersById;

assert.equal(canSwap(roster, players, 'QB', 'WR1'), false);
assert.equal(canSwap(roster, players, 'QB', 'BN1'),
  roster.BN1 === null || players[roster.BN1].position === 'QB');
assert.equal(canSwap(roster, players, 'WR1', 'WR2'), true);
assert.equal(canSwap(roster, players, 'WR1', 'QB'), false);
assert.equal(canSwap(roster, players, 'WR1', 'WR1'), false);
assert.equal(canSwap(roster, players, 'WR1', 'BN1'),
  roster.BN1 === null || players[roster.BN1].position === 'WR');

const before = { ...roster };
const expected = swapRoster(before, 'WR1', 'WR2');
assert.equal(validLineup(expected, players, engine.teamById(teamId).roster), true);
assert.equal(engine.setLineup(teamId, expected), true);
assert.equal(engine.rosterFor(teamId).WR1, before.WR2);
assert.equal(engine.setLineup(teamId, { ...expected, QB: expected.WR1 }), false);
assert.equal(engine.starterVor(teamId),
  Math.round(Object.entries(expected).filter(([key]) => !key.startsWith('BN'))
    .reduce((sum, [, id]) => sum + (id ? players[id].vor : 0), 0) * 10) / 10);

let release;
const events = [];
const manager = createLineup({
  engine, teamId,
  persist: () => new Promise((resolve) => { release = resolve; }),
  notify: (message) => events.push(message),
  onChange: () => {}
});
manager.select('WR1');
assert.equal(manager.selectedPlayerId, expected.WR1);
assert.equal(manager.validTarget('WR2'), true);
assert.equal(manager.validTarget('QB'), false);
manager.select('QB');
assert.equal(manager.selectedSlot, 'WR1');
assert.match(events.at(-1), /cannot play/);
manager.select('WR1');
assert.equal(manager.selectedPlayerId, null);
manager.select('WR1');
manager.select('WR2');
assert.equal(manager.selectedPlayerId, null);
assert.equal(engine.rosterFor(teamId).WR1, before.WR1);
await new Promise((resolve) => setImmediate(resolve));
release({ roster: before, version: 1 });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(manager.pending, false);
assert.equal(engine.rosterFor(teamId).WR1, before.WR1);

const season = new SeasonEngine({ engine });
season.simulateWeek(1, { random: () => .5 });
const finalNames = season.lineup(teamId, 1).map(({ player }) => player?.id);
engine.setLineup(teamId, expected);
assert.deepEqual(season.lineup(teamId, 1).map(({ player }) => player?.id), finalNames);
assert.equal(season.lineup(teamId)[3].player?.id, expected.WR1);
const restored = new SeasonEngine({ engine });
restored.hydrate(season.toJSON());
assert.deepEqual(restored.lineup(teamId, 1).map(({ player }) => player?.id), finalNames);

let rejectSave;
const failed = createLineup({
  engine, teamId,
  persist: () => new Promise((resolve, reject) => { rejectSave = reject; }),
  notify: (message) => events.push(message), onChange: () => {}
});
failed.select('WR1');
failed.select('WR2');
await new Promise((resolve) => setImmediate(resolve));
rejectSave(new Error('conflict'));
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(engine.rosterFor(teamId), expected);
assert.match(events.at(-1), /conflict/);

console.log('Lineup eligibility, optimistic swap, rollback, final-week snapshot, and starter VOR passed.');
