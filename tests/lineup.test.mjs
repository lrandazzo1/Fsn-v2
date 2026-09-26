import assert from 'node:assert/strict';
import { canSwap, createLineup, swapRoster, validLineup } from '../js/lineup.js';
import { DraftEngine } from '../js/draftEngine.js';
import { SeasonEngine } from '../js/seasonEngine.js';
import swapHandler from '../api/roster/swap.js';

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

const previousUrl = process.env.SUPABASE_URL;
const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const previousFetch = global.fetch;
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-server-key';
let requestBody;
global.fetch = async (url, options) => {
  assert.match(url, /\/rest\/v1\/rpc\/fsnv2_swap_lineup$/);
  assert.equal(options.headers.Authorization, 'Bearer test-server-key');
  requestBody = JSON.parse(options.body);
  return { ok: true, json: async () => ({ roster: expected, version: 2 }) };
};
const res = {
  status(code) { this.statusCode = code; return this; },
  setHeader() { return this; },
  json(body) { this.body = body; }
};
const draftId = '12345678-1234-1234-1234-123456789abc';
await swapHandler({ method: 'POST', body: {
  draftId, teamId, from: 'WR1', to: 'WR2',
  fromPlayerId: expected.WR1, toPlayerId: expected.WR2, expectedVersion: 1
} }, res);
assert.equal(res.statusCode, 200);
assert.equal(requestBody.p_expected_version, 1);
assert.equal(requestBody.p_team_id, teamId);
await swapHandler({ method: 'POST', body: {
  draftId, teamId, from: 'QB', to: 'WR1', fromPlayerId: expected.QB,
  toPlayerId: expected.WR1, expectedVersion: -1
} }, res);
assert.equal(res.statusCode, 400);

// PostgREST matches an RPC by the exact key set, so the signature in
// migration 0008 and the keys this route sends have to stay identical.
assert.deepEqual(Object.keys(requestBody).sort(), [
  'p_draft_id', 'p_expected_version', 'p_from', 'p_from_player',
  'p_team_id', 'p_to', 'p_to_player'
]);

// PGRST202 once (a stale schema cache) is retried, not surfaced.
const swap = { draftId, teamId, from: 'WR1', to: 'WR2',
  fromPlayerId: expected.WR1, toPlayerId: expected.WR2, expectedVersion: 1 };
const missing = { ok: false, status: 404, json: async () => ({ code: 'PGRST202',
  message: 'Could not find the function public.fsnv2_swap_lineup(...) in the schema cache' }) };
let calls = 0;
global.fetch = async () => (++calls === 1 ? missing : { ok: true, json: async () => ({ roster: expected, version: 3 }) });
await swapHandler({ method: 'POST', body: swap }, res);
assert.equal(calls, 2);
assert.equal(res.statusCode, 200);
assert.equal(res.body.version, 3);

// Still missing after the retry: the migration is not on the project. Say that
// rather than repeating PostgREST's wording in the toast.
calls = 0;
global.fetch = async () => { calls += 1; return missing; };
await swapHandler({ method: 'POST', body: swap }, res);
assert.equal(calls, 2);
assert.equal(res.statusCode, 503);
assert.match(res.body.error, /0008_fsnv2_lineup_swaps\.sql/);

global.fetch = previousFetch;
if (previousUrl === undefined) delete process.env.SUPABASE_URL;
else process.env.SUPABASE_URL = previousUrl;
if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;

console.log('Lineup eligibility, optimistic swap, rollback, API routing, final-week snapshot, and starter VOR passed.');
