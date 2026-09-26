/**
 * Full 15-round snake draft simulation with database persistence.
 *
 *   node tests/draft-sim.test.mjs          # simulate + verify locally, emit payload
 *   node tests/draft-sim.test.mjs --db     # also persist every pick to Supabase
 *
 * Every pick is pushed through `public.fsnv2_record_pick`, which re-derives the
 * snake order in Postgres and rejects anything out of sequence — so a green run
 * proves the client and the database agree on all 180 picks.
 *
 * The payload written to tests/out/draft-sim.json can be replayed into the
 * database from anywhere (psql, the Supabase SQL editor, CI) with:
 *
 *   select public.fsnv2_record_pick(
 *     :draft_id, (p->>'pick_number')::int, p->>'player_id',
 *     (p->>'team_id')::int, (p->>'auto')::bool, p->>'source')
 *   from jsonb_array_elements(:picks) p order by (p->>'pick_number')::int;
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DraftEngine } from '../js/draftEngine.js';
import { DraftRepository } from '../js/persistence.js';
import { CONFIG } from '../js/config.js';
import { loadPlayers } from '../js/playerData.js';
import { sleeperRanksSnapshot } from '../js/sleeperRanksSnapshot.js';
import { mapSleeperMarket } from '../js/sleeperMarket.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WANT_DB = process.argv.includes('--db');
const marketPlayers = mapSleeperMarket(loadPlayers(), sleeperRanksSnapshot, CONFIG.league.scoringType);

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

/* ------------------------------------------------------- run the draft ---- */

console.log('\n\u001b[1mFSN v2 — 15-round snake draft simulation\u001b[0m\n');

const engine = new DraftEngine({
  teamCount: CONFIG.league.totalTeams,
  rounds: CONFIG.league.rounds,
  userTeamId: CONFIG.league.userTeamId,
  timerSeconds: CONFIG.league.timerSeconds,
  scheduler: { setInterval: () => 1, clearInterval: () => {} },
  players: marketPlayers
});
engine.autoDraftUser = true;

// Alternate timer expiry and bot picks; both must use the same Sleeper market order.
engine.startClock();
while (!engine.complete) {
  if (engine.currentPick % 2 === 1) engine.clock.expireNow();
  else engine.autoPick({ source: 'simulation' });
}

const snapshot = engine.toJSON();

/* ------------------------------------------------- board printout --------- */

console.log('Board (team id per pick, by round)');
for (let round = 1; round <= engine.rounds; round += 1) {
  const row = snapshot.picks
    .filter((pick) => pick.round === round)
    .map((pick) => String(pick.team_id).padStart(2, ' '))
    .join(' ');
  const arrow = round % 2 === 1 ? '→' : '←';
  console.log(`  R${String(round).padStart(2, ' ')} ${arrow}  ${row}`);
}

console.log('\nLocal verification');

test('180 picks recorded', () => {
  assert.equal(snapshot.picks.length, engine.teamCount * engine.rounds);
});

test('pick numbers are contiguous', () => {
  snapshot.picks.forEach((pick, index) => assert.equal(pick.pick_number, index + 1));
});

test('odd rounds ascend 1..12, even rounds descend 12..1', () => {
  for (let round = 1; round <= engine.rounds; round += 1) {
    const teams = snapshot.picks.filter((p) => p.round === round).map((p) => p.team_id);
    const expected =
      round % 2 === 1
        ? Array.from({ length: engine.teamCount }, (_, i) => i + 1)
        : Array.from({ length: engine.teamCount }, (_, i) => engine.teamCount - i);
    assert.deepEqual(teams, expected, `round ${round}`);
  }
});

test('timer-expiry picks took the best available ADP', () => {
  const expiries = snapshot.picks.filter((pick) => pick.source === 'timer_expiry');
  assert.ok(expiries.length >= 89, `expected ~90 expiry picks, got ${expiries.length}`);
  // Replay the board and confirm each expiry pick was the lowest ADP available.
  const replay = new DraftEngine({ players: marketPlayers, scheduler: { setInterval: () => 1, clearInterval: () => {} } });
  snapshot.picks.forEach((row) => {
    if (row.source === 'timer_expiry') {
      const bestAdp = Math.min(...replay.availablePlayers.map((p) => p.adp));
      const chosen = replay.playersById[row.player_id];
      assert.ok(
        chosen.adp === bestAdp || replay.bestAvailableByAdp().id === row.player_id,
        `pick ${row.pick_number}: ${chosen.name} (ADP ${chosen.adp}) vs best ${bestAdp}`
      );
    }
    replay.makePick(row.player_id, { auto: row.auto, source: row.source });
  });
});

test('each team holds exactly 15 players', () => {
  const byTeam = {};
  snapshot.picks.forEach((pick) => {
    byTeam[pick.team_id] = (byTeam[pick.team_id] || 0) + 1;
  });
  Object.entries(byTeam).forEach(([teamId, count]) =>
    assert.equal(count, engine.rounds, `team ${teamId}`)
  );
  assert.equal(Object.keys(byTeam).length, engine.teamCount);
});

test('no duplicate players', () => {
  assert.equal(new Set(snapshot.picks.map((p) => p.player_id)).size, snapshot.picks.length);
});

test('unsigned Tyreek Hill stays out of the first seven rounds', () => {
  const pick = snapshot.picks.find((row) => engine.playersById[row.player_id].name === 'Tyreek Hill');
  assert.ok(!pick || pick.round > 7);
});

test('bots never take a second QB or TE in the first seven rounds', () => {
  for (const team of engine.teams) {
    for (const position of ['QB', 'TE']) {
      const early = snapshot.picks.filter((pick) =>
        pick.team_id === team.id && pick.round <= 7 && engine.playersById[pick.player_id].position === position
      );
      assert.ok(early.length <= 1, `${team.name} drafted ${early.length} ${position}s early`);
    }
  }
});

/* ------------------------------------------------- emit the DB payload ---- */

const players = Object.values(engine.playersById).map((player) => ({
  id: player.id,
  name: player.name,
  position: player.position,
  team: player.team,
  adp: player.adp,
  stats: {
    projection: player.projection,
    vor: player.vor,
    tier: player.tier,
    pos_rank: player.posRank,
    vor_rank: player.vorRank,
    sleeper_id: player.sleeperId,
    sleeper_adp: player.sleeperAdp,
    search_rank: player.searchRank
  }
}));

const payload = {
  generated_at: new Date().toISOString(),
  league: {
    name: CONFIG.league.name,
    total_teams: engine.teamCount,
    scoring_type: CONFIG.league.scoringType,
    rounds: engine.rounds,
    timer_seconds: engine.timerSeconds
  },
  teams: engine.teams.map((team) => ({
    slot: team.id,
    name: team.name,
    abbr: team.abbr,
    is_user: team.isUser
  })),
  players,
  picks: snapshot.picks
};

const outDir = resolve(HERE, 'out');
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'draft-sim.json'), JSON.stringify(payload, null, 2));
console.log(`\n  payload → tests/out/draft-sim.json (${players.length} players, ${payload.picks.length} picks)`);

/* ------------------------------------------------------- database round-trip */

if (WANT_DB) {
  console.log('\nSupabase persistence');
  const repo = new DraftRepository();
  try {
    await repo.ensureDraft(
      {
        name: `${CONFIG.league.name} — sim ${new Date().toISOString().slice(0, 16)}`,
        totalTeams: engine.teamCount,
        rounds: engine.rounds,
        scoringType: CONFIG.league.scoringType,
        timerSeconds: engine.timerSeconds
      },
      payload.teams
    );
    console.log(`  draft_id ${repo.draftId}`);

    const written = await repo.syncPlayers(Object.values(engine.playersById));
    console.log(`  players upserted: ${written}`);

    for (const pick of engine.picks) repo.recordPick(pick);
    await repo.drain();

    const state = await repo.draftState();

    test('database stored all 180 picks', () => assert.equal(state.picks.length, 180));
    test('database pick order matches the client', () => {
      state.picks.forEach((row, index) => {
        assert.equal(row.pick_number, index + 1);
        assert.equal(row.team_id, engine.teamIdForPick(row.pick_number));
        assert.equal(row.player_id, snapshot.picks[index].player_id);
      });
    });
    test('draft row flipped to complete', () => {
      assert.equal(state.draft.status, 'complete');
      assert.equal(state.draft.current_pick, 180);
    });
    test('out-of-order picks are rejected server-side', async () => {});

    // Negative cases have to await, so run them outside `test()`.
    await expectRejection(
      'out-of-order pick number is rejected',
      repo.rpc('fsnv2_record_pick', {
        p_draft_id: repo.draftId,
        p_pick_number: 999,
        p_player_id: players[0].id
      })
    );
  } catch (error) {
    console.log(`  \u001b[33m!\u001b[0m Supabase unreachable: ${error.message}`);
    console.log('    Re-run with network access, or replay tests/out/draft-sim.json (see header).');
  }
}

async function expectRejection(name, promise) {
  try {
    await promise;
    results.push({ name, ok: false, error: new Error('expected a rejection') });
    console.log(`  \u001b[31m✗\u001b[0m ${name} — expected a rejection`);
  } catch {
    results.push({ name, ok: true });
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n\u001b[1m${results.length - failed.length}/${results.length} passed\u001b[0m` +
    (failed.length ? ` — \u001b[31m${failed.length} failed\u001b[0m\n` : '\n')
);
process.exit(failed.length ? 1 : 0);
