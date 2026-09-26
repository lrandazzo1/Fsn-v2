/**
 * Terminal test-suite for the season matchup engine.
 *   node tests/season.test.mjs
 *
 * Covers Phase 2: the 14-week schedule (complete round robin through week 11,
 * randomised rotation after), the dummy score engine, and the W-L / Points For
 * / Points Against standings the League Overview reads.
 *
 * The schedule assertions are the important ones — they are what "verify that
 * switching weeks shows the correct matchups for all 12 franchises" means in
 * terms the test-runner can check.
 */

import assert from 'node:assert/strict';
import { DraftEngine } from '../js/draftEngine.js';
import {
  SEASON_SEED,
  SeasonEngine,
  buildSchedule,
  lcgShuffle,
  roundRobinRounds,
  winProbability
} from '../js/seasonEngine.js';
import {
  NFL_ABBRS,
  annotatePlayers,
  hasLiveSlate,
  isByeWeek,
  nflOpponent,
  normalizeAbbr,
  opponentLabel,
  setLiveSlate
} from '../js/nflTeams.js';
import { buildLivePool, buildLiveSlate, playerKey } from '../js/liveData.js';

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

const manualScheduler = { setInterval: () => 1, clearInterval: () => {} };

/** Deterministic RNG so simulated weeks are reproducible run to run. */
function seededRandom(seed = 12345) {
  let state = seed % 2147483647 || 1;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

function newSeason(options = {}) {
  const engine = new DraftEngine({ scheduler: manualScheduler });
  return { engine, season: new SeasonEngine({ engine, random: seededRandom(), ...options }) };
}

/** Drafts all 180 picks so every team has a full starting lineup. */
function draftedSeason() {
  const engine = new DraftEngine({ scheduler: manualScheduler });
  engine.autoDraftUser = true;
  engine.simulateAll();
  return { engine, season: new SeasonEngine({ engine, random: seededRandom() }) };
}

console.log('\n\u001b[1mFSN v2 — season matchup engine\u001b[0m\n');

/* --------------------------------------------------------- schedule shape -- */

console.log('14-week schedule');

test('a 12-team league schedules 84 games — 6 a week for 14 weeks', () => {
  const schedule = buildSchedule({ totalTeams: 12, weeks: 14 });
  assert.equal(schedule.length, 84);
  for (let week = 1; week <= 14; week += 1) {
    assert.equal(schedule.filter((game) => game.week === week).length, 6, `week ${week}`);
  }
});

test('every team plays exactly once a week, all 14 weeks', () => {
  const schedule = buildSchedule({ totalTeams: 12, weeks: 14 });
  for (let week = 1; week <= 14; week += 1) {
    const playing = schedule
      .filter((game) => game.week === week)
      .flatMap((game) => [game.teamAId, game.teamBId])
      .sort((a, b) => a - b);
    assert.deepEqual(playing, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], `week ${week}`);
  }
});

test('nobody is ever scheduled against themselves', () => {
  buildSchedule({ totalTeams: 12, weeks: 14 }).forEach((game) => {
    assert.notEqual(game.teamAId, game.teamBId);
  });
});

test('weeks 1-11 are a complete round robin: all 66 pairs, each exactly once', () => {
  const schedule = buildSchedule({ totalTeams: 12, weeks: 14 }).filter((game) => game.week <= 11);
  assert.equal(schedule.length, 66); // C(12,2)

  const seen = new Map();
  schedule.forEach((game) => {
    const key = [game.teamAId, game.teamBId].sort((a, b) => a - b).join('-');
    seen.set(key, (seen.get(key) || 0) + 1);
  });

  assert.equal(seen.size, 66, 'every pairing should be distinct');
  assert.equal(Math.max(...seen.values()), 1, 'no pairing should repeat inside weeks 1-11');
});

test('each team meets all 11 opponents once across weeks 1-11', () => {
  const schedule = buildSchedule({ totalTeams: 12, weeks: 14 }).filter((game) => game.week <= 11);
  for (let teamId = 1; teamId <= 12; teamId += 1) {
    const opponents = schedule
      .filter((game) => game.teamAId === teamId || game.teamBId === teamId)
      .map((game) => (game.teamAId === teamId ? game.teamBId : game.teamAId))
      .sort((a, b) => a - b);
    const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((id) => id !== teamId);
    assert.deepEqual(opponents, expected, `team ${teamId}`);
  }
});

test('weeks 12-14 are a randomised rotation, not a continuation of the round robin', () => {
  const schedule = buildSchedule({ totalTeams: 12, weeks: 14 });
  const late = schedule.filter((game) => game.week >= 12);

  assert.equal(late.length, 18);
  late.forEach((game) => assert.equal(game.rematch, true));

  // Each closing week is still a valid perfect matching...
  [12, 13, 14].forEach((week) => {
    const playing = late
      .filter((game) => game.week === week)
      .flatMap((game) => [game.teamAId, game.teamBId])
      .sort((a, b) => a - b);
    assert.deepEqual(playing, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], `week ${week}`);
  });

  // ...and the three weeks are drawn from different rounds, so the closing
  // stretch is not simply weeks 1-3 replayed in order.
  const signature = (week) =>
    late
      .filter((game) => game.week === week)
      .map((game) => [game.teamAId, game.teamBId].sort((a, b) => a - b).join('-'))
      .sort()
      .join('|');
  assert.notEqual(signature(12), signature(13));
  assert.notEqual(signature(13), signature(14));
  assert.notEqual(signature(12), signature(14));
});

test('the week 12-14 rematch is played at the other franchise', () => {
  const schedule = buildSchedule({ totalTeams: 12, weeks: 14 });
  const pairKey = (game) => [game.teamAId, game.teamBId].sort((a, b) => a - b).join('-');

  schedule
    .filter((game) => game.week >= 12)
    .forEach((rematch) => {
      const first = schedule.find(
        (game) => game.week <= 11 && pairKey(game) === pairKey(rematch)
      );
      assert.ok(first, 'every rematch should have a first meeting in weeks 1-11');
      assert.equal(rematch.teamAId, first.teamBId, 'sides should swap');
      assert.equal(rematch.teamBId, first.teamAId, 'sides should swap');
    });
});

/* ----------------------------------------------------------- determinism -- */

console.log('\nDeterminism (the Postgres mirror depends on it)');

test('the same seed always produces the same schedule', () => {
  const a = buildSchedule({ totalTeams: 12, weeks: 14, seed: SEASON_SEED });
  const b = buildSchedule({ totalTeams: 12, weeks: 14, seed: SEASON_SEED });
  assert.deepEqual(a, b);
});

test('a different seed rotates weeks 12-14 differently', () => {
  const late = (seed) =>
    buildSchedule({ totalTeams: 12, weeks: 14, seed })
      .filter((game) => game.week >= 12)
      .map((game) => `${game.week}:${game.teamAId}v${game.teamBId}`)
      .join('|');
  assert.notEqual(late(SEASON_SEED), late(999));
});

test('weeks 1-11 are seed-independent — the round robin is fixed', () => {
  const early = (seed) =>
    buildSchedule({ totalTeams: 12, weeks: 14, seed })
      .filter((game) => game.week <= 11)
      .map((game) => `${game.week}:${game.teamAId}v${game.teamBId}`)
      .join('|');
  assert.equal(early(SEASON_SEED), early(999));
});

test('lcgShuffle is a permutation and matches its Postgres mirror', () => {
  // These three vectors were read back from public.fsnv2_lcg_shuffle() so a
  // drift between the JS and SQL implementations fails here first.
  assert.deepEqual(lcgShuffle(11, 20260208), [2, 10, 4, 1, 5, 3, 7, 0, 8, 9, 6]);
  assert.deepEqual(lcgShuffle(11, 20260201), [5, 4, 3, 7, 1, 9, 2, 8, 10, 0, 6]);
  assert.deepEqual(lcgShuffle(11, 7), [10, 4, 8, 6, 7, 3, 5, 1, 2, 9, 0]);

  const shuffled = lcgShuffle(32, 1234);
  assert.deepEqual([...shuffled].sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i));
});

test('roundRobinRounds rejects an odd entry count', () => {
  assert.throws(() => roundRobinRounds([1, 2, 3]), /even entry count/);
});

test('roundRobinRounds gives n-1 rounds of n/2 pairs', () => {
  const rounds = roundRobinRounds([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(rounds.length, 11);
  rounds.forEach((round) => assert.equal(round.length, 6));
});

/* ------------------------------------------------------------ the engine -- */

console.log('\nSeasonEngine');

test('a fresh engine generates all 14 weeks as unplayed', () => {
  const { season } = newSeason();
  assert.equal(season.matchups.length, 84);
  assert.equal(season.weekNumbers.length, 14);
  assert.ok(season.matchups.every((game) => game.status === 'scheduled'));
  assert.equal(season.currentWeek, 1);
});

test('matchupsForWeek returns the 6 games of any week, covering all 12 teams', () => {
  const { season } = newSeason();
  season.weekNumbers.forEach((week) => {
    const games = season.matchupsForWeek(week);
    assert.equal(games.length, 6, `week ${week}`);
    const teams = games.flatMap((game) => [game.teamAId, game.teamBId]).sort((a, b) => a - b);
    assert.deepEqual(teams, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], `week ${week}`);
  });
});

test('every franchise has exactly one matchup in every week', () => {
  const { season } = newSeason();
  season.weekNumbers.forEach((week) => {
    for (let teamId = 1; teamId <= 12; teamId += 1) {
      const game = season.matchupForTeam(week, teamId);
      assert.ok(game, `team ${teamId} week ${week}`);
      assert.ok(game.teamAId === teamId || game.teamBId === teamId);
      const opponent = season.opponentOf(week, teamId);
      assert.notEqual(opponent, teamId);
    }
  });
});

test('lineup() returns one entry per starter slot, in slot order', () => {
  const { season } = draftedSeason();
  const lineup = season.lineup(1);
  assert.equal(lineup.length, 9);
  assert.deepEqual(
    lineup.map((entry) => entry.slot.key),
    ['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLEX', 'DST', 'K']
  );
  assert.ok(lineup.every((entry) => entry.player !== null), 'a full draft fills every starter');
});

test('weekly projection is the season projection spread over 17 games', () => {
  const { engine, season } = draftedSeason();
  const player = Object.values(engine.playersById)[0];
  assert.equal(season.weeklyProjection(player), Math.round((player.projection / 17) * 10) / 10);
  assert.equal(season.weeklyProjection(null), 0);
});

/* ------------------------------------------------------------ simulation -- */

console.log('\nSimulate Week (dummy score engine)');

test('simulating a week scores every rostered player and finalises 6 games', () => {
  const { engine, season } = draftedSeason();
  const { scores, matchups } = season.simulateWeek(1);

  assert.equal(scores.length, 12 * 15, 'all 180 rostered players get a score');
  assert.equal(matchups.length, 6);
  assert.ok(matchups.every((game) => game.status === 'final'));
  assert.ok(season.isWeekPlayed(1));
  assert.equal(season.currentWeek, 2);

  // 9 of each team's 15 rows are starters — only those count to the total.
  assert.equal(scores.filter((row) => row.starter).length, 12 * 9);
  assert.ok(scores.every((row) => row.points >= 0));
});

test('a matchup total equals the sum of that team’s starters', () => {
  const { season } = draftedSeason();
  const { scores } = season.simulateWeek(1);

  season.matchupsForWeek(1).forEach((game) => {
    [[game.teamAId, game.teamAScore], [game.teamBId, game.teamBScore]].forEach(([teamId, total]) => {
      const expected = scores
        .filter((row) => row.team_id === teamId && row.starter)
        .reduce((sum, row) => sum + row.points, 0);
      assert.ok(
        Math.abs(expected - total) < 0.011,
        `team ${teamId}: total ${total} vs starters ${expected.toFixed(2)}`
      );
    });
  });
});

test('scores land near the projection but are not identical to it', () => {
  const { season } = draftedSeason();
  const { scores } = season.simulateWeek(1);
  const starters = scores.filter((row) => row.starter && row.projected > 3);

  assert.ok(starters.some((row) => row.points !== row.projected), 'variance should move scores');
  const mean =
    starters.reduce((sum, row) => sum + row.points / row.projected, 0) / starters.length;
  assert.ok(mean > 0.85 && mean < 1.15, `average score/projection ratio was ${mean.toFixed(3)}`);
});

test('a played week cannot be double-counted', () => {
  const { season } = draftedSeason();
  season.simulateWeek(1);
  const before = season.standings().reduce((sum, row) => sum + row.games, 0);
  season.simulateThrough(1); // already final — nothing to replay
  assert.equal(season.standings().reduce((sum, row) => sum + row.games, 0), before);
});

test('simulateWeek rejects a week that is not on the schedule', () => {
  const { season } = draftedSeason();
  assert.throws(() => season.simulateWeek(99), /not on the schedule/);
});

test('simulateThrough plays every unplayed week up to the target', () => {
  const { season } = draftedSeason();
  season.simulateThrough(5);
  [1, 2, 3, 4, 5].forEach((week) => assert.ok(season.isWeekPlayed(week), `week ${week}`));
  assert.equal(season.isWeekPlayed(6), false);
  assert.equal(season.currentWeek, 6);
});

test('resetSeason clears results but keeps the schedule', () => {
  const { season } = draftedSeason();
  season.simulateThrough(3);
  season.resetSeason();

  assert.equal(season.matchups.length, 84, 'the schedule survives');
  assert.ok(season.matchups.every((game) => game.status === 'scheduled'));
  assert.ok(season.matchups.every((game) => game.teamAScore === 0 && game.teamBScore === 0));
  assert.equal(season.scores.size, 0);
  assert.equal(season.standings().reduce((sum, row) => sum + row.games, 0), 0);
});

test('resetSeason can roll back a single week', () => {
  const { season } = draftedSeason();
  season.simulateThrough(3);
  season.resetSeason(2);

  assert.ok(season.isWeekPlayed(1));
  assert.equal(season.isWeekPlayed(2), false);
  assert.ok(season.isWeekPlayed(3));
  assert.equal(season.standings().reduce((sum, row) => sum + row.games, 0), 12 * 2);
});

/* ------------------------------------------------------------- standings -- */

console.log('\nStandings (W-L, Points For, Points Against)');

test('an unplayed season leaves every record at 0-0', () => {
  const { season } = draftedSeason();
  const rows = season.standings();
  assert.equal(rows.length, 12);
  rows.forEach((row) => {
    assert.equal(row.games, 0);
    assert.equal(row.wins, 0);
    assert.equal(row.pointsFor, 0);
    assert.equal(row.streak, '—');
  });
});

test('after one week every team has a result and wins balance losses', () => {
  const { season } = draftedSeason();
  season.simulateWeek(1);
  const rows = season.standings();

  const wins = rows.reduce((sum, row) => sum + row.wins, 0);
  const losses = rows.reduce((sum, row) => sum + row.losses, 0);
  const ties = rows.reduce((sum, row) => sum + row.ties, 0);

  assert.equal(rows.reduce((sum, row) => sum + row.games, 0), 12);
  assert.equal(wins, losses);
  // Six games: each is a win/loss pair or a tie on both sides. Exact ties are
  // rare but legitimate — team totals are sums of tenths, so they do collide.
  assert.equal(wins + ties / 2, 6, `${wins}W ${losses}L ${ties}T`);
  assert.equal(ties % 2, 0, 'a tie always lands on both sides');
  rows.forEach((row) => assert.equal(row.wins + row.losses + row.ties, row.games));
});

test('a tied game counts as half a win for both sides', () => {
  const { season } = draftedSeason();
  // Force the tie rather than waiting for one: ~0.8% of games tie naturally.
  season.hydrate({
    matchups: [{ week: 1, team_a_id: 1, team_b_id: 2, team_a_score: 111, team_b_score: 111, status: 'final' }],
    scores: []
  });

  const row = season.standings().find((entry) => entry.teamId === 1);
  assert.equal(row.ties, 1);
  assert.equal(row.wins, 0);
  assert.equal(row.losses, 0);
  assert.equal(row.pct, 0.5);
  assert.equal(season.recordLabel(1), '0-0-1');
  assert.equal(row.streak, 'T1');
});

test('league-wide Points For always equals Points Against', () => {
  const { season } = draftedSeason();
  season.simulateThrough(14);
  const rows = season.standings();

  const pf = rows.reduce((sum, row) => sum + row.pointsFor, 0);
  const pa = rows.reduce((sum, row) => sum + row.pointsAgainst, 0);
  assert.ok(Math.abs(pf - pa) < 0.05, `PF ${pf.toFixed(2)} vs PA ${pa.toFixed(2)}`);
});

test('a full season gives every franchise 14 games and wins balance losses', () => {
  const { season } = draftedSeason();
  season.simulateThrough(14);
  const rows = season.standings();

  rows.forEach((row) => assert.equal(row.games, 14, `team ${row.teamId}`));
  assert.equal(
    rows.reduce((sum, row) => sum + row.wins, 0),
    rows.reduce((sum, row) => sum + row.losses, 0)
  );
  assert.equal(rows.reduce((sum, row) => sum + row.games, 0), 12 * 14);
});

test('standings are ranked 1..12 by win percentage, then points for', () => {
  const { season } = draftedSeason();
  season.simulateThrough(14);
  const rows = season.standings();

  assert.deepEqual(rows.map((row) => row.rank), Array.from({ length: 12 }, (_, i) => i + 1));
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const row = rows[i];
    assert.ok(
      prev.pct > row.pct || (prev.pct === row.pct && prev.pointsFor >= row.pointsFor),
      `row ${i} out of order`
    );
  }
});

test('diff and pct agree with the underlying counts', () => {
  const { season } = draftedSeason();
  season.simulateThrough(6);
  season.standings().forEach((row) => {
    assert.ok(Math.abs(row.diff - (row.pointsFor - row.pointsAgainst)) < 0.011);
    assert.equal(row.pct, (row.wins + row.ties * 0.5) / row.games);
  });
});

test('recordLabel reads "W-L" and the streak counts the current run', () => {
  const { season } = draftedSeason();
  season.simulateThrough(4);
  const row = season.standings()[0];
  // Two teams can roll the same total, and recordLabel() then reads "W-L-T".
  // Asserting "W-L" unconditionally made this test fail roughly one run in
  // forty — the label was right and the assertion was not.
  const expected = row.ties
    ? `${row.wins}-${row.losses}-${row.ties}`
    : `${row.wins}-${row.losses}`;
  assert.equal(season.recordLabel(row.teamId), expected);
  assert.match(row.streak, /^[WLT]\d+$/);
});

/* ------------------------------------------------- scoreboard presentation */

console.log('\nScoreboard presentation');

test('displayTotal shows the projection before the week and the score after', () => {
  const { season } = draftedSeason();
  const projected = season.displayTotal(1, 1);
  assert.equal(projected, season.projectedTotal(1));

  season.simulateWeek(1);
  const game = season.matchupForTeam(1, 1);
  const actual = game.teamAId === 1 ? game.teamAScore : game.teamBScore;
  assert.equal(season.displayTotal(1, 1), actual);
});

test('win probability is 0.5 at a dead heat and monotonic in the margin', () => {
  assert.equal(winProbability(0), 0.5);
  assert.ok(winProbability(20) > winProbability(5));
  assert.ok(winProbability(-20) < 0.5);
  assert.ok(winProbability(500) > 0.99 && winProbability(500) <= 1);
  assert.ok(winProbability(-500) < 0.01 && winProbability(-500) >= 0);
});

test('a finished game reports a result, not a forecast', () => {
  const { season } = draftedSeason();
  season.simulateWeek(1);
  season.matchupsForWeek(1).forEach((game) => {
    const prob = season.winProbabilityFor(game);
    const expected = game.teamAScore === game.teamBScore ? 0.5 : game.teamAScore > game.teamBScore ? 1 : 0;
    assert.equal(prob, expected);
  });
});

test('both sides of a game see complementary win probabilities', () => {
  const { season } = draftedSeason();
  const game = season.matchupsForWeek(3)[0];
  const probA = season.winProbabilityFor(game);
  assert.ok(probA > 0 && probA < 1);

  // The view flips the number for whichever side it puts on the left.
  const margin = season.projectedTotal(game.teamAId) - season.projectedTotal(game.teamBId);
  assert.ok(Math.abs(probA - winProbability(margin)) < 1e-12);
  assert.ok(Math.abs((1 - probA) - winProbability(-margin)) < 1e-12);
});

/* ------------------------------------------------------------ NFL context -- */

console.log('\nNFL opponent context');

/**
 * A week-1 slate in the two shapes the app is handed: normalised
 * `fsnv2_nfl_schedule` rows, and raw Tank01 `/getNFLGamesForWeek` entries. SF is
 * away at WAS, CLE is away at BAL; MIN and CHI have no game, so they are on bye.
 */
const WEEK_1_GAMES = [
  { external_id: '20260910_SF@WAS', week: 1, home_team: 'WSH', away_team: 'SF' },
  { gameID: '20260913_CLE@BAL', gameWeek: 'Week 1', away: 'CLE', home: 'BAL' },
  { gameID: '20260913_JAC@PIT', gameWeek: 'Week 1' },
  { external_id: '20260913_SEA@NYJ', week: 1, home_team: 'NYJ', away_team: 'SEA' }
];

/** Installs the week-1 slate; every test that needs it calls this first. */
function loadWeek1() {
  const slate = buildLiveSlate(WEEK_1_GAMES);
  setLiveSlate(slate);
  return slate;
}

test('all 32 franchises are known and every player team resolves', () => {
  const { engine } = draftedSeason();
  assert.equal(NFL_ABBRS.length, 32);
  Object.values(engine.playersById).forEach((player) => {
    assert.ok(NFL_ABBRS.includes(player.team), `unknown NFL team: ${player.team}`);
  });
});

test('the offline seed pool has Deebo Samuel on SF, not WAS', () => {
  const { engine } = draftedSeason();
  const deebo = Object.values(engine.playersById).find((p) => p.name === 'Deebo Samuel');
  assert.ok(deebo, 'Deebo Samuel should be in the pool');
  assert.equal(deebo.team, 'SF');
});

test('feed spellings fold onto our 32 franchise codes', () => {
  assert.equal(normalizeAbbr('WSH'), 'WAS');
  assert.equal(normalizeAbbr('JAC'), 'JAX');
  assert.equal(normalizeAbbr('OAK'), 'LV');
  assert.equal(normalizeAbbr('sf'), 'SF');
  assert.equal(normalizeAbbr(''), '');
  assert.equal(normalizeAbbr(null), '');
});

test('with no slate loaded nothing is invented — every label is "—"', () => {
  setLiveSlate(null);
  assert.equal(hasLiveSlate(1), false);
  NFL_ABBRS.forEach((abbr) => {
    assert.equal(nflOpponent(abbr, 1), null);
    assert.equal(opponentLabel(abbr, 1), '—');
    assert.equal(isByeWeek(abbr, 1), false, 'an unsynced week is not a bye');
  });
});

test('buildLiveSlate reads both the fsnv2 and the raw Tank01 game shapes', () => {
  const slate = loadWeek1();
  assert.deepEqual([...slate.keys()], [1]);
  assert.equal(Object.keys(slate.get(1)).length, 8, 'four games, both sides of each');
  // gameID alone: '20260913_JAC@PIT' is JAX away at PIT.
  assert.deepEqual(nflOpponent('JAX', 1), { opponent: 'PIT', home: false });
});

test('opponentLabel reads "@ HOME" on the road and "vs AWAY" at home', () => {
  loadWeek1();
  assert.equal(opponentLabel('SF', 1), '@ WAS', 'SF is away at Washington');
  assert.equal(opponentLabel('WAS', 1), 'vs SF');
  assert.equal(opponentLabel('WSH', 1), 'vs SF', 'the feed spelling resolves too');
  assert.equal(opponentLabel('BAL', 1), 'vs CLE');
  assert.equal(opponentLabel('CLE', 1), '@ BAL');
});

test('both sides of a synced game agree, and exactly one is at home', () => {
  loadWeek1();
  ['SF', 'WAS', 'CLE', 'BAL', 'JAX', 'PIT', 'SEA', 'NYJ'].forEach((abbr) => {
    const game = nflOpponent(abbr, 1);
    assert.ok(game, `${abbr} should have a week 1 game`);
    assert.notEqual(game.opponent, abbr);
    const reverse = nflOpponent(game.opponent, 1);
    assert.equal(reverse.opponent, abbr, 'opponents should agree');
    assert.equal(reverse.home, !game.home, 'exactly one side is at home');
  });
});

test('a team with no game in a synced week is on BYE', () => {
  loadWeek1();
  assert.equal(isByeWeek('MIN', 1), true);
  assert.equal(opponentLabel('MIN', 1), 'BYE');
  assert.equal(opponentLabel('CHI', 1), 'BYE');
  // …but an unsynced week stays '—' rather than claiming 24 byes.
  assert.equal(hasLiveSlate(2), false);
  assert.equal(opponentLabel('MIN', 2), '—');
});

test('annotatePlayers stamps {team, opponent} onto the payload', () => {
  loadWeek1();
  const players = [
    { name: 'Deebo Samuel', position: 'WR', team: 'SF' },
    { name: 'Terry McLaurin', position: 'WR', team: 'WSH' },
    { name: 'Justin Jefferson', position: 'WR', team: 'MIN' }
  ];
  annotatePlayers(players, 1);

  assert.deepEqual(
    players.map((p) => [p.team, p.opponent, p.isHome, p.onBye]),
    [
      ['SF', '@ WAS', false, false],
      ['WAS', 'vs SF', true, false],
      ['MIN', 'BYE', null, true]
    ]
  );

  // A week the sync has not reached reports neither a game nor a bye.
  annotatePlayers(players, 2);
  assert.deepEqual(
    players.map((p) => [p.opponent, p.onBye]),
    [['—', false], ['—', false], ['—', false]]
  );
});

test('the live pool takes its team from the synced row, not the seed', () => {
  // The same player as the seed pool has him, but on the roster the sync
  // established — and in Tank01's own spelling for Washington.
  const pool = buildLivePool([
    { id: 'p-0150', name: 'Deebo Samuel', position: 'WR', team: 'SF', stats: { projection: 180 } },
    { id: 'p-0130', name: 'Terry McLaurin', position: 'WR', team: 'WSH', stats: { projection: 238 } },
    { id: 'tank01-1', name: 'Bench Guy', position: 'WR', team: 'MIN', stats: {} },
    { id: 'p-0200', name: 'Vikings D/ST', position: 'DEF', team: 'MIN', stats: { projection: 126 } }
  ]);

  const byName = new Map(pool.map((player) => [player.name, player]));
  assert.equal(byName.get('Deebo Samuel').team, 'SF');
  assert.equal(byName.get('Terry McLaurin').team, 'WAS', 'WSH normalises onto WAS');
  assert.equal(byName.get('Vikings D/ST').position, 'DST', 'DEF normalises onto DST');
  assert.equal(byName.has('Bench Guy'), false, 'a row with no projection cannot drive VOR');
});

test('playerKey folds punctuation so both spellings join', () => {
  assert.equal(playerKey("Ja'Marr Chase"), playerKey('JaMarr Chase'));
  assert.equal(playerKey('Amon-Ra St. Brown'), playerKey('AmonRa St Brown'));
  assert.equal(playerKey('Brian Robinson Jr.'), 'brianrobinsonjr');
});

/* ------------------------------------------------------------- hydration -- */

console.log('\nPersistence round-trip');

test('toJSON / hydrate restores the schedule and every score', () => {
  const { season } = draftedSeason();
  season.simulateThrough(4);
  const snapshot = season.toJSON();

  const { season: restored } = draftedSeason();
  restored.hydrate(snapshot);

  assert.equal(restored.matchups.length, season.matchups.length);
  assert.equal(restored.weeks, 14);
  assert.equal(restored.scores.size, season.scores.size);
  assert.deepEqual(
    restored.matchups.map((game) => `${game.week}:${game.teamAId}v${game.teamBId}:${game.status}`),
    season.matchups.map((game) => `${game.week}:${game.teamAId}v${game.teamBId}:${game.status}`)
  );
  assert.deepEqual(
    restored.standings().map((row) => [row.teamId, row.wins, row.losses]),
    season.standings().map((row) => [row.teamId, row.wins, row.losses])
  );
});

test('hydrate accepts the snake_case rows Postgres returns', () => {
  const { season } = draftedSeason();
  const rows = [
    { week: 1, team_a_id: 3, team_b_id: 9, team_a_score: '118.40', team_b_score: '101.20', status: 'final' },
    { week: 1, team_a_id: 1, team_b_id: 2, team_a_score: '95.00', team_b_score: '110.50', status: 'final' }
  ];
  season.hydrate({ matchups: rows, scores: [{ week: 1, player_id: 'p-0000', points: '21.5' }] });

  assert.equal(season.matchups.length, 2);
  assert.equal(season.weeks, 1);
  assert.equal(season.scoreFor(1, 'p-0000'), 21.5);

  const three = season.standings().find((row) => row.teamId === 3);
  assert.equal(three.wins, 1);
  assert.equal(three.pointsFor, 118.4);
  assert.equal(three.pointsAgainst, 101.2);
});

/* ------------------------------------------------------------------ report */

const failed = results.filter((r) => !r.ok);
console.log(
  `\n\u001b[1m${results.length - failed.length}/${results.length} passed\u001b[0m` +
    (failed.length ? ` — \u001b[31m${failed.length} failed\u001b[0m\n` : '\n')
);
process.exit(failed.length ? 1 : 0);
