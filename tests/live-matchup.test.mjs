import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getCurrentNFLWeek } from '../js/nflWeek.js';
import { SeasonEngine, winProbability } from '../js/seasonEngine.js';
import { inactiveStatus } from '../js/statsEngine.js';
import { annotatePlayers, playerOpponentLabel } from '../js/nflTeams.js';
import { buildLivePool } from '../js/liveData.js';
import { useLiveMatchupStats } from '../js/useLiveMatchupStats.js';
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
      if (path === '/getNFLPlayerList') return { json: { body: [{
        playerID: '123', longName: 'Josh Jacobs', pos: 'RB', status: 'Active',
        injury_status: 'EXEMPT'
      }] } };
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
assert.equal(payload.statuses.find((row) => row.name === 'Josh Jacobs').injury_status, 'EXEMPT');
assert.equal(calls.filter((path) => path === '/getNFLGamesForWeek').length, 1);
assert.equal((await handleLiveMatchupRequest(new Request('https://fsn.local/api/live-matchups?week=0'), {
  provider, now: new Date('2026-09-26T17:00:00Z')
})).status, 400);

const playersById = {
  'p-caleb': { id: 'p-caleb', name: 'Caleb Williams', position: 'QB', team: 'CHI', projection: 340 },
  'p-jefferson': { id: 'p-jefferson', name: 'Justin Jefferson', position: 'WR', team: 'MIN', projection: 300 },
  'p-jacobs': { id: 'p-jacobs', name: 'Josh Jacobs', position: 'RB', team: 'GB', projection: 265,
    status: 'Active', searchRank: 20 },
  'p-bench': { id: 'p-bench', name: 'Bench Player', position: 'RB', team: 'CHI', projection: 120 }
};
const engine = {
  teamCount: 2, playersById,
  rosterFor(id) { return id === 1 ? { QB: 'p-caleb', RB1: 'p-jacobs', BN1: 'p-bench' } : { WR1: 'p-jefferson' }; }
};
const season = new SeasonEngine({ engine, activeNflWeek: 3 });
season.setLiveProjections((player) => ({ 'p-caleb': 20, 'p-jacobs': 15.6,
  'p-jefferson': 25 }[player.id] ?? null));
assert.equal(inactiveStatus(playersById['p-jacobs']), null);
assert.equal(inactiveStatus({ injury_status: 'SUSPENDED' }), 'SUS');
assert.equal(inactiveStatus({ news_status: 'OUT' }), 'OUT');
assert.equal(inactiveStatus({ status: 'IR' }), 'IR');
assert.equal(season.weeklyProjection(playersById['p-jacobs'], 3), 15.6);
season.setLiveMatchupStats(3, payload, playersById);
assert.equal(inactiveStatus(playersById['p-jacobs']), 'EX');
assert.equal(season.weeklyProjection(playersById['p-jacobs'], 3), 0);
assert.equal(playersById['p-jacobs'].projectedPoints, 0);
assert.equal(playersById['p-jacobs'].adp, 151);
assert.equal(season.projectedTotal(1, 3), 20);
const activeGame = season.matchupsForWeek(3)[0];
assert.equal(season.winProbabilityFor(activeGame),
  winProbability(activeGame.teamAId === 1 ? -5 : 5));
season.setLiveMatchupStats(3, { ...payload, statuses: [{
  id: 'tank01-123', name: 'Josh Jacobs', status: 'Active',
  injury_status: null, news_status: null
}] }, playersById);
assert.equal(inactiveStatus(playersById['p-jacobs']), null);
assert.equal(season.weeklyProjection(playersById['p-jacobs'], 3), 15.6);
assert.equal(playersById['p-jacobs'].adp, 20);
season.setLiveMatchupStats(3, payload, playersById);
assert.equal(season.livePointFor(3, playersById['p-caleb']), 19.44);
assert.equal(season.livePointFor(3, playersById['p-bench']), 0);
assert.equal(season.displayTotal(3, 1), 19.44); // Bench scores never enter totals.
assert.equal(season.displayTotal(3, 2), 26.6);
assert.equal(season.liveStatusFor(3, playersById['p-caleb']), 'in_progress');
assert.equal(season.livePointFor(2, playersById['p-caleb']), null);
assert.equal(season.matchupsForWeek(3)[0].status, 'scheduled');
season.setActiveNflWeek(4);
assert.equal(season.hasCompletedBoxScores(3), false);
assert.equal(season.scoreFor(3, 'p-caleb'), null, 'a partial live snapshot is not a final historical score');
season.setActiveNflWeek(3);

const providerHistorical = { async fetchLiveWeek({ week }) {
  assert.equal(week, 1);
  return { games: [{ home_team: 'CHI', away_team: 'MIN', status: 'final' }], stats: [
    { player_id: 'p-caleb', name: 'Caleb Williams', position: 'QB', team: 'CHI', fantasy_points: 11, stats: {} },
    { player_id: 'p-jefferson', name: 'Justin Jefferson', position: 'WR', team: 'MIN', fantasy_points: 26, stats: {} }
  ] };
} };
const historicalResponse = await handleLiveMatchupRequest(
  new Request('https://fsn.local/api/live-matchups?week=1'),
  { provider: providerHistorical, now: new Date('2026-09-26T17:00:00Z') }
);
assert.equal(historicalResponse.status, 200);
const historicalPayload = await historicalResponse.json();
const week2Payload = { ...historicalPayload, week: 2,
  players: historicalPayload.players.map((row) => ({ ...row,
    actualPoints: row.name === 'Caleb Williams' ? 17 : 8 })) };
const historyHook = useLiveMatchupStats({ season, engine, seasonYear: 2026,
  fetcher: async (url) => new Response(JSON.stringify(url.endsWith('week=2')
    ? week2Payload : historicalPayload), { status: 200 }) });
annotatePlayers(playersById, 1);
assert.equal(playerOpponentLabel(playersById['p-caleb'], 1), '—');
await historyHook.fetchWeek(1);
await historyHook.fetchWeek(2);
assert.equal(playerOpponentLabel(playersById['p-caleb'], 1), 'vs MIN',
  'a fetched historical box score supplies the slate even after an earlier empty stamp');
assert.equal(season.scoreFor(1, 'p-caleb'), 11);
assert.equal(season.displayTotal(1, 1), 11);
assert.equal(season.displayTotal(1, 2), 26);
assert.equal(season.matchupsForWeek(1)[0].status, 'final');
assert.equal(season.weeklyProjection(playersById['p-caleb'], 1), 0);
assert.equal(season.winProbabilityFor(season.matchupsForWeek(1)[0]),
  season.matchupsForWeek(1)[0].teamAId === 1 ? 0 : 1);
assert.equal(season.scoreFor(2, 'p-caleb'), 17);
assert.equal(season.displayTotal(2, 1), 17);

const pool = buildLivePool([
  { id: 'p-jacobs', name: 'Josh Jacobs', position: 'RB', team: 'GB', stats: { projection: 265 } },
  { id: 'tank01-jacobs', provider: 'tank01', external_id: 'jacobs', name: 'Josh Jacobs',
    position: 'RB', team: 'GB', status: 'Active', injury: { news_status: 'EXEMPT' }, stats: {} }
]);
assert.equal(inactiveStatus(pool[0]), 'EX');
console.log('Live Week 3 endpoint, scoring, and starter totals passed.');
