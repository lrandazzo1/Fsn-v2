import assert from 'node:assert/strict';
import { DraftEngine } from '../js/draftEngine.js';
import { loadPlayers } from '../js/playerData.js';
import { compareMarket, mapSleeperMarket, marketRank } from '../js/sleeperMarket.js';
import { sleeperRanksSnapshot } from '../js/sleeperRanksSnapshot.js';
import { filterPool } from '../js/uiRenderer.js';
import { buildLivePool } from '../js/liveData.js';

const pool = loadPlayers();
const records = {
  'Bijan Robinson': { player_id: '9509', team: 'ATL', adp_ppr: 2.5, search_rank: 1 },
  'Jahmyr Gibbs': { player_id: '9221', team: 'DET', adp_ppr: null, search_rank: 1 },
  'Tyreek Hill': { player_id: '3321', team: null, adp_ppr: null, search_rank: 145 },
  'Ladd McConkey': { player_id: '11635', team: 'LAC', adp_ppr: null, search_rank: null }
};
const mapped = mapSleeperMarket(pool, records);
const find = (name) => mapped.find((player) => player.name === name);
assert.equal(find('Bijan Robinson').adp, 2.5, 'real ADP takes priority over search rank');
assert.equal(find('Jahmyr Gibbs').adp, 1, 'missing ADP uses Sleeper search rank');
assert.equal(find('Ladd McConkey').adp, 999, 'both ranks missing use the late baseline');
assert.equal(find('Tyreek Hill').team, 'FA');
assert.equal(find('Tyreek Hill').adp, 220, 'unsigned free agent gets late floor');
assert.equal(marketRank(find('Tyreek Hill')), 220);

const live = buildLivePool([
  { id: 'db-hill', name: 'Tyreek Hill', position: 'WR', team: 'MIA', stats: { projection: 255 } },
  { id: 'db-chase', name: 'JaMarr Chase', position: 'WR', team: 'CIN', stats: { projection: 330 } }
]);
const synced = mapSleeperMarket(live, {
  ...records, "Ja'Marr Chase": { player_id: '7564', team: 'CIN', search_rank: 4 }
});
assert.equal(synced.find((player) => player.id === 'db-hill').team, 'FA', 'current roster null overrides old DB team');
assert.equal(synced.find((player) => player.id === 'db-chase').adp, 4, 'live pool matches punctuation variants');

const livePool = mapSleeperMarket(pool, sleeperRanksSnapshot);
const engine = new DraftEngine({ players: livePool, scheduler: { setInterval: () => 1, clearInterval: () => {} } });
const board = filterPool(engine, { search: '', hideDrafted: true, position: 'ALL', sort: 'adp' });
assert.deepEqual(board, engine.availablePlayers.sort(compareMarket), 'board defaults to the same market order as bots');
assert.equal(engine.bestAvailableByAdp().id, board[0].id);
assert.equal(engine.botSelection().id, board[0].id);
assert.equal(engine.autoPick().playerId, board[0].id);
assert.ok(engine.playersById[find('Tyreek Hill').id].adp >= 220);

console.log('Sleeper market mapping, board, bot, and free agent checks passed');
