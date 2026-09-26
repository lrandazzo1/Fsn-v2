import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getCurrentNFLWeek } from '../js/nflWeek.js';
import { SeasonEngine } from '../js/seasonEngine.js';
import { readEnv } from '../lib/services/env.ts';
import { createTank01Provider } from '../lib/services/providers/tank01.ts';
import { handleLiveMatchupRequest } from '../lib/api/liveMatchupRoute.ts';

assert.equal(getCurrentNFLWeek(new Date('2026-09-10T12:00:00Z'), 2026), 1);
assert.equal(getCurrentNFLWeek(new Date('2026-09-17T12:00:00Z'), 2026), 2);
assert.equal(getCurrentNFLWeek(new Date('2026-09-26T17:00:00Z'), 2026), 3);
assert.equal(getCurrentNFLWeek(new Date('2026-09-29T12:00:00Z'), 2026), 3);

const box = JSON.parse(await readFile(new URL('../lib/fixtures/tank01/getNFLBoxScore.20260913_CHI@MIN.json', import.meta.url)));
const calls = [];
const provider = createTank01Provider({
  env: readEnv({}, new Date('2026-09-26T17:00:00Z')),
  http: {
    async getJson(path) {
      calls.push(path);
      if (path === '/getNFLGamesForWeek') return { json: { body: [{
        gameID: '20260927_CHI@MIN', gameWeek: 'Week 3', home: 'MIN', away: 'CHI',
        gameStatus: 'In Progress'
      }] } };
      if (path === '/getNFLTeams') return { json: { body: [] } };
      if (path === '/getNFLBoxScore') return { json: box };
      throw new Error(`Unexpected endpoint ${path}`);
    }
  }
});

const req = new Request('https://fsn.local/api/live-matchups?week=3');
const res = await handleLiveMatchupRequest(req, { provider, now: new Date('2026-09-26T17:00:00Z') });
assert.equal(res.status, 200);
const payload = await res.json();
assert.equal(payload.week, 3);
assert.equal(payload.games[0].status, 'in_progress');
assert.equal(payload.players.find((row) => row.name === 'Caleb Williams').actualPoints, 19.44);
assert.equal(payload.players.find((row) => row.name === 'Justin Jefferson').actualPoints, 26.6);
assert.equal(payload.players.find((row) => row.position === 'DST' && row.team === 'MIN').actualPoints, 14);
assert.equal(calls.filter((path) => path === '/getNFLGamesForWeek').length, 1);
assert.equal((await handleLiveMatchupRequest(new Request('https://fsn.local/api/live-matchups?week=0'), {
  provider, now: new Date('2026-09-26T17:00:00Z')
})).status, 400);

const playersById = {
  'p-caleb': { id: 'p-caleb', name: 'Caleb Williams', position: 'QB', team: 'CHI', projection: 340 },
  'p-jefferson': { id: 'p-jefferson', name: 'Justin Jefferson', position: 'WR', team: 'MIN', projection: 300 },
  'p-bench': { id: 'p-bench', name: 'Bench Player', position: 'RB', team: 'CHI', projection: 120 }
};
const engine = {
  teamCount: 2, playersById,
  rosterFor(id) { return id === 1 ? { QB: 'p-caleb', BN1: 'p-bench' } : { WR1: 'p-jefferson' }; }
};
const season = new SeasonEngine({ engine });
season.setLiveMatchupStats(3, payload, playersById);
assert.equal(season.livePointFor(3, playersById['p-caleb']), 19.44);
assert.equal(season.livePointFor(3, playersById['p-bench']), 0);
assert.equal(season.displayTotal(3, 1), 19.44); // Bench scores never enter totals.
assert.equal(season.displayTotal(3, 2), 26.6);
assert.equal(season.liveStatusFor(3, playersById['p-caleb']), 'in_progress');
assert.equal(season.livePointFor(2, playersById['p-caleb']), null);
assert.equal(season.matchupsForWeek(3)[0].status, 'scheduled');
console.log('Live Week 3 endpoint, scoring, and starter totals passed.');
