#!/usr/bin/env node
/**
 * scripts/test-sync-data.ts   →   npm run test:sync-data
 * -----------------------------------------------------------------------------
 * Verifies the ingestion layer end to end: endpoint responses map to our row
 * shapes, and every sync writes to the database as an UPSERT.
 *
 * It runs clean (exit 0) with no credentials and no network by replaying the
 * recorded payloads in lib/fixtures/tank01 through the *production* Tank01
 * mapper, and by driving the *production* repository against an in-memory stand
 * -in for the `fsnv2_sync_*` RPCs that mirrors migration 0004's unique keys and
 * counts (lib/services/testing/memoryRpc.ts).
 *
 * Extra phases switch on when there is something real to talk to:
 *
 *   SPORTS_DATA_API_KEY + SPORTS_DATA_API_HOST   live provider endpoint check
 *   SPORTS_DATA_TEST_LIVE=1 (or --live) plus     live Supabase round trip,
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY     writing provider='fixture' rows
 *
 * A phase with nothing to talk to is reported as skipped, not failed — the point
 * is a check that a CI job without secrets can still run on every commit.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { createSportsDataService } from '../lib/services/sportsData.ts';
import { currentNflWeek, currentSeason, readEnv, seasonKickoff, weekFocus } from '../lib/services/env.ts';
import { handleSyncRequest, weeklyPlan } from '../lib/api/syncRoute.ts';
import { createLogger, silentLogger } from '../lib/services/logger.ts';
import { createSupabaseSyncRepository } from '../lib/services/syncRepository.ts';
import { listProviders, resolveProvider } from '../lib/services/providers/index.ts';
import { createTank01Provider } from '../lib/services/providers/tank01.ts';
import { createMemoryRpc } from '../lib/services/testing/memoryRpc.ts';
import type { SportsDataEnv } from '../lib/services/env.ts';
import type { RpcTransport } from '../lib/services/syncRepository.ts';
import type { ProviderContext, SyncResult } from '../lib/services/types.ts';

/* --------------------------------------------------------------- harness -- */

interface Outcome {
  name: string;
  ok: boolean;
  skipped?: boolean;
  error?: Error;
}

const results: Outcome[] = [];
const VERBOSE = process.argv.includes('--verbose');

/** Thrown by a check that cannot run here — reported as skipped, not failed. */
class SkipCheck extends Error {}

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  \u001b[32m✓\u001b[0m ${name}\n`);
  } catch (error) {
    if (error instanceof SkipCheck) {
      skip(name, error.message);
      return;
    }
    results.push({ name, ok: false, error: error as Error });
    process.stdout.write(`  \u001b[31m✗\u001b[0m ${name}\n      ${(error as Error).message}\n`);
  }
}

function skip(name: string, why: string): void {
  results.push({ name, ok: true, skipped: true });
  process.stdout.write(`  \u001b[33m•\u001b[0m ${name} \u001b[2m(skipped: ${why})\u001b[0m\n`);
}

function section(title: string): void {
  process.stdout.write(`\n\u001b[1m${title}\u001b[0m\n`);
}

/* ------------------------------------------------------------- fixtures -- */

const SEASON = 2026;
const WEEK = 3;

/** The env the fixture phases run under — no credentials, no network. */
function fixtureEnv(overrides: Partial<SportsDataEnv> = {}): SportsDataEnv {
  return {
    ...readEnv({ SPORTS_DATA_PROVIDER: 'fixture', SPORTS_DATA_SEASON: String(SEASON) }),
    logLevel: VERBOSE ? 'debug' : 'silent',
    ...overrides
  };
}

function fixtureContext(week?: number): ProviderContext {
  return { season: SEASON, seasonType: 'reg', scoringFormat: 'ppr', week };
}

function fixtureProvider(overrides: Partial<SportsDataEnv> = {}) {
  const env = fixtureEnv(overrides);
  return resolveProvider({ env, logger: VERBOSE ? createLogger({ level: 'debug' }) : silentLogger });
}

/**
 * A service whose provider reads fixtures and whose writes go through the real
 * repository (batching, counting, retries) into `rpc`.
 */
function fixtureService(options: {
  rpc: RpcTransport;
  batchSize?: number;
  env?: Partial<SportsDataEnv>;
}) {
  const env = fixtureEnv({
    ...(options.batchSize ? { batchSize: options.batchSize } : {}),
    ...(options.env ?? {})
  });
  const logger = VERBOSE ? createLogger({ level: 'debug' }) : silentLogger;

  return createSportsDataService({
    env,
    logger,
    repository: createSupabaseSyncRepository({
      provider: 'fixture',
      rpc: options.rpc,
      batchSize: env.batchSize,
      logger
    })
  });
}

/** find-then-assert in one step, so the row stays non-nullable downstream. */
function need<T>(value: T | undefined, label: string): T {
  if (value === undefined || value === null) throw new Error(`${label} not found`);
  return value;
}

function assertWritten(result: SyncResult, label: string): void {
  assert.equal(result.ok, true, `${label} failed: ${result.errors.join(' | ')}`);
  assert.ok(result.fetched > 0, `${label} fetched nothing`);
  assert.equal(
    result.written,
    result.inserted + result.updated,
    `${label}: written should equal inserted + updated`
  );
  assert.ok(result.runId, `${label}: no fsnv2.sync_runs audit row was written`);
}

/* ------------------------------------------------- phase 1: configuration -- */

async function phaseConfiguration(): Promise<void> {
  section('1. Configuration and provider selection');

  await check('readEnv defaults to the tank01 provider and the current NFL season', () => {
    const env = readEnv({}, new Date('2026-09-24T00:00:00Z'));
    assert.equal(env.provider, 'tank01');
    assert.equal(env.season, 2026);
    assert.equal(env.seasonType, 'reg');
    assert.equal(env.scoringFormat, 'ppr');
    assert.equal(env.batchSize, 120);
    assert.equal(env.endpoints.projections, '/getNFLProjections');
    // February belongs to the previous season.
    assert.equal(currentSeason(new Date('2027-02-01T00:00:00Z')), 2026);
  });

  await check('SPORTS_DATA_PROVIDER swaps the provider with no code change', () => {
    assert.deepEqual(listProviders(), ['fixture', 'tank01']);
    const env = readEnv({ SPORTS_DATA_PROVIDER: 'fixture' });
    assert.equal(resolveProvider({ env, logger: silentLogger }).name, 'fixture');
  });

  await check('an unknown provider fails fast with the registered names', () => {
    const env = readEnv({ SPORTS_DATA_PROVIDER: 'nope' });
    assert.throws(() => resolveProvider({ env, logger: silentLogger }), /Unknown SPORTS_DATA_PROVIDER "nope".*tank01/s);
  });

  await check('the default provider refuses to run without SPORTS_DATA_API_KEY', async () => {
    const env = readEnv({ SPORTS_DATA_PROVIDER: 'tank01', SPORTS_DATA_API_HOST: 'example.test' });
    const provider = resolveProvider({ env, logger: silentLogger });
    await assert.rejects(
      () => provider.fetchTeams(fixtureContext()),
      /missing SPORTS_DATA_API_KEY/
    );
  });

  await check('SPORTS_DATA_ENDPOINT_* overrides the path for a generic RapidAPI host', () => {
    const env = readEnv({
      SPORTS_DATA_PROVIDER: 'tank01',
      SPORTS_DATA_API_KEY: 'k',
      SPORTS_DATA_API_HOST: 'nfl.example.test',
      SPORTS_DATA_ENDPOINT_PROJECTIONS: '/v2/fantasy/projections',
      SPORTS_DATA_ENDPOINT_BOX_SCORE: '/v2/games/boxscore'
    });
    const described = resolveProvider({ env, logger: silentLogger }).describe();
    assert.equal(described.endpoints.projections, '/v2/fantasy/projections');
    assert.equal(described.endpoints.boxScore, '/v2/games/boxscore');
    assert.equal(described.host, 'nfl.example.test');
    assert.equal(described.configured, true);
  });

  await check('an invalid week is rejected before any request is made', async () => {
    const service = fixtureService({ rpc: createMemoryRpc().rpc });
    await assert.rejects(() => service.syncWeeklyProjections(0), /week must be an integer/);
    await assert.rejects(() => service.syncBoxScores(23), /week must be an integer/);
  });
}

/* ------------------------------------------- phase 2: endpoint → row map -- */

async function phaseMapping(): Promise<void> {
  section('2. Provider payloads map onto the database schema');

  await check('getNFLTeams → teams, with bye week, division and logo', async () => {
    const teams = await fixtureProvider().fetchTeams(fixtureContext());
    assert.equal(teams.length, 4);
    const chi = need(teams.find((team) => team.abbr === 'CHI'), 'CHI');
    assert.equal(chi.external_id, '6');
    assert.equal(chi.city, 'Chicago');
    assert.equal(chi.name, 'Bears');
    assert.equal(chi.bye_week, 7); // read from byeWeeks["2026"]
    assert.match(String(chi.logo_url), /^https:\/\//);
  });

  await check('getNFLTeams?rosters=true → players, positions normalised, non-fantasy dropped', async () => {
    const players = await fixtureProvider().fetchPlayers(fixtureContext());
    // 11 roster entries, minus the offensive lineman the fantasy pool has no slot for.
    assert.equal(players.length, 10);
    assert.equal(players.some((player) => player.name === 'Ozzy Trapilo'), false);

    const santos = need(players.find((player) => player.name === 'Cairo Santos'), 'Cairo Santos');
    assert.equal(santos.position, 'K', 'PK should normalise to K');
    assert.equal(santos.team, 'CHI');

    const williams = need(players.find((player) => player.external_id === '4430807'), 'Caleb Williams');
    assert.equal(williams.position, 'QB');
    assert.equal(williams.nfl_team_external_id, '6');
    assert.equal(williams.jersey, '18');
    assert.equal(williams.bye_week, 7);
    assert.equal(williams.college, 'USC');

    const swift = need(players.find((player) => player.external_id === '4259545'), "D'Andre Swift");
    assert.equal(swift.status, 'Questionable', 'injury designation should surface as status');

    for (const player of players) {
      assert.ok(player.external_id && player.name, 'every row needs an id and a name');
      assert.match(player.team, /^[A-Z]{2,4}$/);
    }
  });

  await check('a traded player takes the roster he is on, not the team on his record', async () => {
    // The bug this guards: Tank01 leaves the stale club on a traded player's own
    // record for a while, so a profile kept showing a former team. The roster he
    // appears on is the affiliation. `WSH` also has to land as `WAS`, the
    // abbreviation the app keys its colours, logos and slate on.
    const payload = {
      statusCode: 200,
      body: [
        {
          teamID: '21',
          teamAbv: 'MIN',
          teamCity: 'Minnesota',
          teamName: 'Vikings',
          byeWeeks: { '2026': ['6'] },
          Roster: {
            '3917315': {
              playerID: '3917315',
              longName: 'Kyler Murray',
              pos: 'QB',
              team: 'ARI', // stale on the player record
              teamID: '22', // stale too
              jerseyNum: '1'
            }
          }
        },
        {
          teamID: '28',
          teamAbv: 'WSH',
          teamCity: 'Washington',
          teamName: 'Commanders',
          byeWeeks: { '2026': ['9'] },
          Roster: [
            { playerID: '4685702', longName: 'Jayden Daniels', pos: 'QB', team: 'WSH', teamID: '28' }
          ]
        }
      ]
    };

    const provider = resolveProvider({
      env: fixtureEnv({ provider: 'tank01', baseUrl: 'https://sports-data.test' }),
      logger: silentLogger,
      fetch: async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    });

    const players = await provider.fetchPlayers(fixtureContext());
    const murray = need(players.find((player) => player.external_id === '3917315'), 'Kyler Murray');
    assert.equal(murray.team, 'MIN', 'the roster he is on wins over his own record');
    assert.equal(murray.nfl_team_external_id, '21');
    assert.equal(murray.bye_week, 6, 'the bye week comes with the new club');

    const daniels = need(players.find((player) => player.external_id === '4685702'), 'Jayden Daniels');
    assert.equal(daniels.team, 'WAS', 'WSH should canonicalise to WAS');
  });

  await check('team codes resolve from the roster, then teamAbv, then teamID', async () => {
    // A payload in the spellings the live API actually uses: WSH for
    // Washington, JAC for Jacksonville, and a roster entry carrying only a
    // numeric teamID. All three have to land on the 32 codes the schedule, the
    // projections and the UI are keyed by, or a player's opponent joins to
    // nothing and the board shows someone else's game.
    const teams = [
      { teamID: '28', teamAbv: 'WSH', teamCity: 'Washington', teamName: 'Commanders' },
      { teamID: '15', teamAbv: 'JAC', teamCity: 'Jacksonville', teamName: 'Jaguars' },
      { teamID: '31', teamAbv: 'SF', teamCity: 'San Francisco', teamName: '49ers' }
    ];
    const rosters = [
      {
        ...teams[0],
        Roster: { '1': { playerID: '1', longName: 'Terry McLaurin', pos: 'WR', teamID: '28' } }
      },
      {
        ...teams[1],
        Roster: { '2': { playerID: '2', longName: 'Brian Thomas Jr.', pos: 'WR' } }
      },
      {
        ...teams[2],
        // The entry's own `team` still says his old club; the roster he appears
        // on is the affiliation, and it wins.
        Roster: { '3': { playerID: '3', longName: 'Deebo Samuel Sr.', pos: 'WR', team: 'WSH' } }
      }
    ];

    const provider = createTank01Provider({
      env: fixtureEnv({ provider: 'tank01' }),
      logger: silentLogger,
      http: {
        calls: 0,
        async getJson<T>(
          path: string,
          query: Record<string, string | number | boolean | undefined> = {}
        ) {
          const body = path.includes('getNFLTeams')
            ? query.rosters === 'true'
              ? rosters
              : teams
            : [
                { gameID: '20260910_SF@WSH', gameWeek: 'Week 1', away: 'SF', home: 'WSH' },
                { gameID: '20260910_JAC@LA', gameWeek: 'Week 1', away: 'JAC', home: 'LA' }
              ];
          return {
            url: path,
            status: 200,
            json: { statusCode: 200, body } as T,
            durationMs: 0
          };
        }
      }
    });

    const mapped = await provider.fetchTeams(fixtureContext());
    assert.deepEqual(
      mapped.map((team) => team.abbr).sort(),
      ['JAX', 'SF', 'WAS'],
      'WSH and JAC fold onto WAS and JAX'
    );

    const players = await provider.fetchPlayers(fixtureContext());
    const byName = new Map(players.map((player) => [player.name, player.team]));
    assert.equal(byName.get('Terry McLaurin'), 'WAS', 'from the roster, spelling folded');
    assert.equal(byName.get('Brian Thomas Jr.'), 'JAX', 'the roster names the team');
    assert.equal(byName.get('Deebo Samuel Sr.'), 'SF', 'the roster beats a stale team field');
    assert.equal(
      players.some((player) => player.team === 'FA'),
      false,
      'no player may fall through to FA while its team is resolvable'
    );

    const games = await provider.fetchSchedules({ ...fixtureContext(), weeks: [1] });
    assert.deepEqual(
      games.map((game) => `${game.away_team}@${game.home_team}`).sort(),
      ['JAX@LAR', 'SF@WAS'],
      'both sides of a game use the same codes the players do'
    );
  });

  await check('getNFLProjections → projections, stats flattened, defenses included', async () => {
    const rows = await fixtureProvider().fetchProjections(fixtureContext(WEEK));
    assert.equal(rows.length, 8); // 6 skill players + 2 team defenses

    const williams = need(rows.find((row) => row.external_player_id === '4430807'), 'Caleb Williams');
    assert.equal(williams.season, SEASON);
    assert.equal(williams.week, WEEK);
    assert.equal(williams.scoring_format, 'ppr');
    assert.equal(williams.fantasy_points, 19.4, 'string fantasy points should coerce to a number');
    assert.equal(williams.stats['passing.passYds'], 248.6, 'nested stat groups should flatten');
    assert.equal(williams.player_id, 'fixture-4430807');
    // The live feed sends no opponent on projections; the database derives it.
    assert.equal(williams.opponent, null);

    assert.equal(williams.stats.playerID, undefined, 'identity fields are not statistics');
    assert.equal(williams.stats.teamID, undefined);

    // Some rows report points as { standard, halfPPR, PPR } instead of a value:
    // the league's scoring format picks the branch.
    const stBrown = need(
      rows.find((row) => row.external_player_id === '4374302'),
      'Amon-Ra St. Brown'
    );
    assert.equal(stBrown.fantasy_points, 17.1);

    // The live teamDefenseProjections node is keyed by numeric teamID, so the
    // abbreviation has to come from teamAbv — reading the key produced DST-18.
    const defense = need(
      rows.find((row) => row.external_player_id === 'DST-MIN'),
      'MIN team defense projection'
    );
    assert.equal(defense.position, 'DST');
    assert.equal(defense.team, 'MIN');
    assert.equal(defense.fantasy_points, 8.2, "the provider's own defensive total is kept");
    assert.equal(defense.opponent, null);
    assert.equal(
      rows.some((row) => /^DST-\d+$/.test(row.external_player_id)),
      false,
      'no team defense may be keyed by a numeric id'
    );
  });

  await check('getNFLGamesForWeek → schedule rows with UTC kickoffs and statuses', async () => {
    const games = await fixtureProvider().fetchSchedules({ ...fixtureContext(), weeks: [WEEK] });
    assert.equal(games.length, 2);

    const chiAtMin = need(
      games.find((game) => game.external_id === '20260913_CHI@MIN'),
      'CHI@MIN'
    );
    assert.equal(chiAtMin.home_team, 'MIN');
    assert.equal(chiAtMin.away_team, 'CHI');
    assert.equal(chiAtMin.week, WEEK);
    assert.equal(chiAtMin.season, SEASON);
    assert.equal(chiAtMin.status, 'final', 'Completed should map to final');
    assert.equal(chiAtMin.home_score, 24);
    assert.equal(chiAtMin.away_score, 20);
    // From gameTime_epoch.
    assert.equal(chiAtMin.kickoff, '2026-09-13T17:00:00.000Z');

    const gbAtDet = need(games.find((game) => game.external_id === '20260913_GB@DET'), 'GB@DET');
    assert.equal(gbAtDet.status, 'scheduled');
    // No epoch on this one: parsed from gameDate + gameTime in US Eastern.
    assert.equal(gbAtDet.kickoff, '2026-09-13T20:25:00.000Z');
    assert.equal(gbAtDet.neutral_site, false);
  });

  await check('getNFLBoxScore → weekly_stats rows with opponents and snap counts', async () => {
    const rows = await fixtureProvider().fetchBoxScores(fixtureContext(WEEK));
    assert.ok(rows.length >= 4, `expected at least 4 box-score rows, got ${rows.length}`);

    const jefferson = need(
      rows.find((row) => row.external_player_id === '4262921'),
      'Justin Jefferson'
    );
    assert.equal(jefferson.team, 'MIN');
    assert.equal(jefferson.opponent, 'CHI', 'opponent should come from the game it was played in');
    assert.equal(jefferson.fantasy_points, 24.6);
    assert.equal(jefferson.stats['receiving.recYds'], 126);
    assert.equal(jefferson.snap_counts?.offSnaps, 58);
    assert.equal(jefferson.stats.playerID, undefined, 'identity fields are not statistics');
    assert.equal(jefferson.stats['snapcounts.offSnaps'], undefined, 'snaps live in their own column');
    assert.equal(jefferson.game_external_id, '20260913_CHI@MIN');
    assert.equal(jefferson.week, WEEK);
    // Box-score entries carry no position; the database fills it in.
    assert.equal(jefferson.position, null);

    // A box score's DST node is keyed 'home'/'away' and carries no fantasy
    // total, so it is computed: 3 sacks + 1 int + 1 fumble + 1 TD, 20 allowed.
    const defense = need(
      rows.find((row) => row.external_player_id === 'DST-MIN'),
      'MIN team defense box score'
    );
    assert.equal(defense.team, 'MIN');
    assert.equal(defense.opponent, 'CHI');
    assert.equal(defense.fantasy_points, 3 * 1 + 2 + 2 + 6 + 1);
    assert.equal(
      need(rows.find((row) => row.external_player_id === 'DST-CHI'), 'CHI defense').fantasy_points,
      1,
      '1 sack and 24 points allowed'
    );
    assert.equal(
      rows.some((row) => /^DST-(HOME|AWAY|\d+)$/i.test(row.external_player_id)),
      false,
      "the node's home/away key must not become the team"
    );
  });

  await check('team-defense scoring covers the points-allowed tiers', async () => {
    const { defenseFantasyPoints, pointsAllowedBonus } = await import(
      '../lib/services/providers/tank01.ts'
    );

    assert.deepEqual(
      [0, 6, 13, 20, 27, 34, 45].map((allowed) => pointsAllowedBonus(allowed)),
      [10, 7, 4, 1, 0, -1, -4]
    );

    // A shutout with nothing else: the tier alone.
    assert.equal(defenseFantasyPoints({ ptsAllowed: '0', sacks: '0' }), 10);
    // Both payloads' spellings of the same stats must score identically.
    assert.equal(
      defenseFantasyPoints({ sacks: '2', defensiveInterceptions: '1', ptsAllowed: '14' }),
      defenseFantasyPoints({ defSack: '2', interceptions: '1', ptsAgainst: '14' })
    );
    // A return touchdown counts too.
    assert.equal(defenseFantasyPoints({ returnTD: '1', ptsAllowed: '21' }), 6);
    // Nothing to score on: null, rather than a misleading zero.
    assert.equal(defenseFantasyPoints({ teamAbv: 'CHI' }), null);
  });

  await check('a provider 500 surfaces as a failed result, not a crash', async () => {
    const attempts: string[] = [];
    const failing = async (input: string): Promise<Response> => {
      attempts.push(input);
      return new Response('upstream exploded', { status: 500 });
    };
    const env = { ...fixtureEnv(), provider: 'tank01', maxRetries: 1, retryBaseMs: 0 };
    const service = createSportsDataService({ env, fetch: failing, logger: silentLogger });
    const health = await service.healthCheck();
    assert.equal(health.ok, false);
    assert.match(health.errors[0] ?? '', /failed \(500\)/);
    assert.equal(attempts.length, 2, 'one retry, then give up');
  });
}

/* ------------------------------------------------ phase 3: database writes -- */

async function phaseDatabase(): Promise<void> {
  section('3. Database writes are UPSERTs (in-memory RPC double)');

  await check('syncPlayersAndRosters writes teams and players, then updates in place', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });

    const first = await service.syncPlayersAndRosters();
    assertWritten(first, 'players_rosters');
    assert.equal(first.inserted, 14, '4 teams + 10 players inserted');
    assert.equal(first.updated, 0);
    assert.equal(memory.store.teams.size, 4);
    assert.equal(memory.store.players.size, 10);
    assert.equal(memory.store.players.get('fixture:4430807')?.id, 'fixture-4430807');

    const second = await service.syncPlayersAndRosters();
    assertWritten(second, 'players_rosters (rerun)');
    assert.equal(second.inserted, 0, 'a rerun must not insert a single duplicate row');
    assert.equal(second.updated, 14);
    assert.equal(memory.store.teams.size, 4);
    assert.equal(memory.store.players.size, 10);
    assert.equal(memory.store.runs.length, 2, 'both runs audited');
  });

  await check('syncWeeklyProjections is idempotent and refreshes the numbers', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });

    const first = await service.syncWeeklyProjections(WEEK);
    assertWritten(first, 'weekly_projections');
    assert.equal(first.inserted, 8);
    assert.equal(memory.store.projections.size, 8);

    const second = await service.syncWeeklyProjections(WEEK);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 8);
    assert.equal(memory.store.projections.size, 8, 'no duplicate projection rows');

    const key = `fixture:${SEASON}:reg:${WEEK}:ppr:4430807`;
    assert.equal(memory.store.projections.get(key)?.fantasy_points, 19.4);
  });

  await check('syncBoxScores is idempotent', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });

    const first = await service.syncBoxScores(WEEK);
    assertWritten(first, 'box_scores');
    const rowCount = memory.store.weeklyStats.size;
    assert.ok(rowCount >= 4);

    const second = await service.syncBoxScores(WEEK);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, rowCount);
    assert.equal(memory.store.weeklyStats.size, rowCount);
    assert.equal(Number(first.detail.games), 2, 'both games in the week were read');
  });

  await check('syncSchedules is idempotent and re-runs pick up score changes', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });

    const first = await service.syncSchedules({ weeks: [WEEK] });
    assertWritten(first, 'schedules');
    assert.equal(first.inserted, 2);
    assert.deepEqual(first.detail.weeks, [WEEK]);

    const second = await service.syncSchedules({ weeks: WEEK });
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 2);
    assert.equal(memory.store.schedules.size, 2);
    assert.equal(memory.store.schedules.get('fixture:20260913_CHI@MIN')?.status, 'final');
  });

  await check("a projection's opponent is derived from the synced schedule", async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });

    // Order matters, and it is the order the weekly cron runs in.
    await service.syncSchedules({ weeks: [WEEK] });
    await service.syncWeeklyProjections(WEEK);

    const williams = need(
      memory.store.projections.get(`fixture:${SEASON}:reg:${WEEK}:ppr:4430807`),
      'Caleb Williams projection'
    );
    // CHI are away at MIN in the fixture week, so the opponent is MIN.
    assert.equal(williams.team, 'CHI');
    assert.equal(williams.opponent, 'MIN');

    const jefferson = need(
      memory.store.projections.get(`fixture:${SEASON}:reg:${WEEK}:ppr:4262921`),
      'Justin Jefferson projection'
    );
    // MIN are at home, so the other side of the same game.
    assert.equal(jefferson.opponent, 'CHI');
  });

  await check("a box-score row's position is derived from the synced player pool", async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });

    await service.syncPlayersAndRosters();
    await service.syncBoxScores(WEEK);

    const jefferson = need(
      memory.store.weeklyStats.get(`fixture:${SEASON}:reg:${WEEK}:4262921`),
      'Justin Jefferson box score'
    );
    assert.equal(jefferson.position, 'WR', 'position comes from fsnv2.players');

    const santos = need(
      memory.store.weeklyStats.get(`fixture:${SEASON}:reg:${WEEK}:17427`),
      'Cairo Santos box score'
    );
    assert.equal(santos.position, 'K', 'the PK normalisation carries through');
  });

  await check('an unsynced game or player leaves the column null rather than failing', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });

    // Nothing else synced first: no schedule, no players.
    const projections = await service.syncWeeklyProjections(WEEK);
    const boxScores = await service.syncBoxScores(WEEK);
    assert.equal(projections.ok, true, projections.errors.join(' | '));
    assert.equal(boxScores.ok, true, boxScores.errors.join(' | '));

    assert.equal(
      need(
        memory.store.projections.get(`fixture:${SEASON}:reg:${WEEK}:ppr:4430807`),
        'projection'
      ).opponent,
      null
    );
    assert.equal(
      need(memory.store.weeklyStats.get(`fixture:${SEASON}:reg:${WEEK}:4262921`), 'box score')
        .position,
      null
    );
  });

  await check('a re-run never trades a derived value back for a null', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });

    await service.syncPlayersAndRosters();
    await service.syncSchedules({ weeks: [WEEK] });
    await service.syncWeeklyProjections(WEEK);
    await service.syncBoxScores(WEEK);

    const projectionKey = `fixture:${SEASON}:reg:${WEEK}:ppr:4430807`;
    const statsKey = `fixture:${SEASON}:reg:${WEEK}:4262921`;
    assert.equal(need(memory.store.projections.get(projectionKey), 'projection').opponent, 'MIN');
    assert.equal(need(memory.store.weeklyStats.get(statsKey), 'box score').position, 'WR');

    // The provider keeps sending null for both; the stored values must survive.
    await service.syncWeeklyProjections(WEEK);
    await service.syncBoxScores(WEEK);
    assert.equal(need(memory.store.projections.get(projectionKey), 'projection').opponent, 'MIN');
    assert.equal(need(memory.store.weeklyStats.get(statsKey), 'box score').position, 'WR');
  });

  await check('rows go up in batches of SPORTS_DATA_BATCH_SIZE', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc, batchSize: 3 });

    await service.syncWeeklyProjections(WEEK);
    const batches = memory.calls.filter((call) => call.name === 'fsnv2_sync_projections');
    assert.equal(batches.length, 3, '8 rows at 3 per batch => 3 calls');
    assert.deepEqual(batches.map((call) => call.rows), [3, 3, 2]);
  });

  await check('a rejected batch is reported, audited and does not throw', async () => {
    const memory = createMemoryRpc();
    const failing = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (name === 'fsnv2_sync_projections') throw new Error('fsnv2_sync_projections failed (503)');
      return memory.rpc(name, args);
    };
    const service = fixtureService({ rpc: failing });

    const result = await service.syncWeeklyProjections(WEEK);
    assert.equal(result.ok, false);
    assert.equal(result.written, 0);
    assert.match(result.errors[0] ?? '', /503/);
    assert.equal(memory.store.runs.length, 1, 'the failure is still audited');
    assert.equal(memory.store.runs[0].p_status, 'error');
    assert.match(String(memory.store.runs[0].p_error), /503/);
  });

  await check('--dry-run maps everything and writes nothing', async () => {
    const memory = createMemoryRpc();
    // The memory repository is wired up and must still receive no write at all.
    const service = fixtureService({ rpc: memory.rpc, env: { dryRun: true } });

    const result = await service.syncWeeklyProjections(WEEK);
    assert.equal(result.ok, true);
    assert.equal(result.fetched, 8);
    assert.equal(result.written, 0);
    assert.equal(memory.store.projections.size, 0);
    assert.equal(memory.calls.length, 0, 'a dry run must not call an rpc');
  });

  await check('the repository refuses to start without Supabase credentials', () => {
    assert.throws(
      () => createSupabaseSyncRepository({ provider: 'tank01', url: '', key: '' }),
      /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/
    );
  });
}


/* ------------------------------------------------ phase 4: the cron route -- */

async function phaseRoute(): Promise<void> {
  section('4. Scheduled route (/api/sync)');

  await check('the committed api/sync.js bundle matches lib/api/syncRoute.ts', () => {
    if (!existsSync('node_modules/esbuild')) {
      // esbuild is a devDependency; without it there is nothing to compare against.
      throw new SkipCheck('esbuild is not installed (npm install)');
    }
    execFileSync('node', ['scripts/build-api.mjs', '--check'], { stdio: 'pipe' });
  });

  await check('the season calendar puts kickoff on the Thursday after Labor Day', () => {
    assert.equal(seasonKickoff(2026).toISOString(), '2026-09-10T00:00:00.000Z');
    assert.equal(seasonKickoff(2025).toISOString(), '2025-09-04T00:00:00.000Z');
    // Sept 1 2027 is a Wednesday, so Labor Day is the 6th and kickoff the 9th.
    assert.equal(seasonKickoff(2027).toISOString(), '2027-09-09T00:00:00.000Z');

    assert.equal(currentNflWeek(new Date('2026-09-01T12:00:00Z'), 2026), 1, 'before kickoff reads as week 1');
    assert.equal(currentNflWeek(new Date('2026-09-16T12:00:00Z'), 2026), 1, 'Wednesday still closes week 1');
    assert.equal(currentNflWeek(new Date('2026-09-17T12:00:00Z'), 2026), 2, 'Thursday opens week 2');
    assert.equal(currentNflWeek(new Date('2026-09-25T12:00:00Z'), 2026), 3);
    assert.equal(currentNflWeek(new Date('2027-06-01T12:00:00Z'), 2026), 18, 'clamped at 18');
  });

  await check('a Tuesday run projects the week ahead and ingests the week just played', () => {
    // Tuesday of week 3: its games finished on Monday night.
    const tuesday = weekFocus(new Date('2026-09-29T09:17:00Z'), 2026);
    assert.deepEqual(tuesday, { week: 3, weekComplete: true, completed: 3, upcoming: 4 });
    assert.deepEqual(
      weeklyPlan(tuesday).map((step) => [step.task, step.week ?? step.weeks]),
      [['players', undefined], ['schedules', [3, 4, 5]], ['projections', 4], ['boxscores', 3]]
    );

    // Thursday of week 4: this week is being played now, so project it instead.
    const thursday = weekFocus(new Date('2026-10-01T09:17:00Z'), 2026);
    assert.deepEqual(thursday, { week: 4, weekComplete: false, completed: 3, upcoming: 4 });
    assert.deepEqual(
      weeklyPlan(thursday).map((step) => step.week ?? step.weeks),
      [undefined, [3, 4, 5], 4, 3]
    );

    // Week 1 has no finished week behind it.
    const opening = weekFocus(new Date('2026-09-11T09:17:00Z'), 2026);
    assert.equal(opening.completed, null);
    assert.equal(weeklyPlan(opening).some((step) => step.task === 'boxscores'), false);
  });

  await check('the route runs the weekly bundle and reports every task', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });
    const response = await handleSyncRequest(new Request('https://fsn.test/api/sync'), {
      service,
      logger: silentLogger,
      env: fixtureEnv(),
      now: new Date('2026-09-29T09:17:00Z')
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'weekly');
    assert.equal(body.provider, 'fixture');
    assert.equal(body.season, SEASON);
    assert.deepEqual(body.focus, { week: 3, weekComplete: true, completed: 3, upcoming: 4 });
    assert.deepEqual(body.skipped_tasks, []);
    assert.deepEqual(
      body.tasks.map((task: Record<string, unknown>) => [task.task, task.week, task.ok]),
      [
        ['players_rosters', null, true],
        ['schedules', null, true],
        ['weekly_projections', 4, true],
        ['box_scores', 3, true]
      ]
    );
    assert.ok(body.written > 0, 'the bundle wrote nothing');
    assert.equal(memory.store.runs.length, 4, 'every task left an audit row');
  });

  await check('an explicit task and week are honoured, and dry_run writes nothing', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });
    const response = await handleSyncRequest(
      new Request('https://fsn.test/api/sync?task=projections&week=3&dry_run=1'),
      { service, logger: silentLogger, env: fixtureEnv(), now: new Date('2026-09-29T09:17:00Z') }
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.mode, 'projections');
    assert.equal(body.dry_run, true);
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].task, 'weekly_projections');
    assert.equal(body.tasks[0].week, 3);
    // The injected service is a live one; dry_run has to be honoured by the
    // route passing it through, not by the caller.
    assert.equal(body.written, 0);
    assert.equal(memory.calls.length, 0);
  });

  await check('CRON_SECRET is enforced when it is configured', async () => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret';
    try {
      const service = fixtureService({ rpc: createMemoryRpc().rpc });
      const options = { service, logger: silentLogger, env: fixtureEnv(), now: new Date('2026-09-29T09:17:00Z') };

      const denied = await handleSyncRequest(new Request('https://fsn.test/api/sync'), options);
      assert.equal(denied.status, 401);
      assert.equal(((await denied.json()) as Record<string, unknown>).error, 'unauthorized');

      const allowed = await handleSyncRequest(
        new Request('https://fsn.test/api/sync?task=players', {
          headers: { authorization: 'Bearer test-secret' }
        }),
        options
      );
      assert.equal(allowed.status, 200);
      assert.deepEqual(((await allowed.json()) as Record<string, unknown>).warnings, []);
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });

  await check('without CRON_SECRET the route answers but warns', async () => {
    const previous = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const service = fixtureService({ rpc: createMemoryRpc().rpc });
      const response = await handleSyncRequest(
        new Request('https://fsn.test/api/sync?task=players'),
        { service, logger: silentLogger, env: fixtureEnv(), now: new Date('2026-09-29T09:17:00Z') }
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, any>;
      assert.equal(body.warnings.length, 1);
      assert.match(body.warnings[0], /CRON_SECRET is not set/);
    } finally {
      if (previous !== undefined) process.env.CRON_SECRET = previous;
    }
  });

  await check('a malformed request is a 400, not a half-run sync', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });
    const options = { service, logger: silentLogger, env: fixtureEnv(), now: new Date('2026-09-29T09:17:00Z') };

    for (const query of ['?task=nonsense', '?task=projections&week=0', '?season=abc', '?task=schedules&weeks=1,99']) {
      // eslint-disable-next-line no-await-in-loop
      const response = await handleSyncRequest(new Request(`https://fsn.test/api/sync${query}`), options);
      assert.equal(response.status, 400, `${query} should be rejected`);
    }
    assert.equal(memory.calls.length, 0, 'nothing should have been written');
  });

  await check('the handler answers a Node-style (req, res) invocation too', async () => {
    // Vercel's Node runtime may call either signature, and the first deployed
    // version of this route only handled Request — it crashed before logging.
    const { default: handler } = await import('../lib/api/syncRoute.ts');

    // This path builds its own logger from the environment — quieten it.
    const previousLevel = process.env.SPORTS_DATA_LOG_LEVEL;
    process.env.SPORTS_DATA_LOG_LEVEL = VERBOSE ? 'debug' : 'silent';

    let ended = '';
    const headers: Record<string, string> = {};
    const response = {
      statusCode: 0,
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      end: (body?: string) => {
        ended = body ?? '';
      }
    };

    const returned = await handler(
      {
        url: '/api/sync?task=nonsense',
        method: 'GET',
        headers: { host: 'fsn.example.com', 'x-forwarded-proto': 'https' }
      },
      response
    );

    if (previousLevel === undefined) delete process.env.SPORTS_DATA_LOG_LEVEL;
    else process.env.SPORTS_DATA_LOG_LEVEL = previousLevel;

    assert.equal(returned, undefined, 'a Node-style call answers through res, not a return value');
    assert.equal(response.statusCode, 400);
    assert.match(headers['content-type'] ?? '', /application\/json/);
    assert.match((JSON.parse(ended) as { error: string }).error, /Unknown task "nonsense"/);
  });

  await check('running out of time reports the tasks that never started', async () => {
    const memory = createMemoryRpc();
    const service = fixtureService({ rpc: memory.rpc });
    const response = await handleSyncRequest(new Request('https://fsn.test/api/sync'), {
      service,
      logger: silentLogger,
      env: fixtureEnv(),
      now: new Date('2026-09-29T09:17:00Z'),
      budgetMs: -1
    });

    assert.equal(response.status, 500, 'a partial run must fail the cron invocation');
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.ok, false);
    assert.equal(body.tasks.length, 0);
    assert.deepEqual(body.skipped_tasks, ['players', 'schedules', 'projections:4', 'boxscores:3']);
  });
}

/* ----------------------------------------------------- phase 5: live checks -- */

async function phaseLive(): Promise<void> {
  section('5. Live provider and database (skipped without credentials)');

  const env = readEnv();
  const wantsLive = process.argv.includes('--live') || process.env.SPORTS_DATA_TEST_LIVE === '1';

  if (!env.apiKey || !(env.apiHost || env.baseUrl)) {
    skip('live provider endpoints respond', 'SPORTS_DATA_API_KEY / SPORTS_DATA_API_HOST not set');
  } else {
    await check('live provider endpoints respond', async () => {
      const service = createSportsDataService({
        env: { ...env, provider: 'tank01', logLevel: VERBOSE ? 'debug' : 'silent' },
        logger: silentLogger
      });
      const health = await service.healthCheck();
      assert.equal(health.ok, true, health.errors.join(' | '));
      assert.ok(health.teams >= 30, `expected ~32 NFL teams, got ${health.teams}`);
    });
  }

  if (!wantsLive) {
    skip('live Supabase round trip', 'pass --live (or SPORTS_DATA_TEST_LIVE=1) to enable');
    return;
  }
  if (env.supabaseKeySource !== 'secret') {
    skip('live Supabase round trip', 'SUPABASE_SERVICE_ROLE_KEY not set');
    return;
  }

  await check('live Supabase round trip: upsert, re-upsert, read back', async () => {
    const service = createSportsDataService({
      env: { ...readEnv({ ...process.env, SPORTS_DATA_PROVIDER: 'fixture' }), logLevel: 'silent' },
      logger: silentLogger
    });

    const first = await service.syncSchedules({ weeks: [WEEK], season: SEASON });
    assertWritten(first, 'live schedules');

    const second = await service.syncSchedules({ weeks: [WEEK], season: SEASON });
    assert.equal(second.ok, true, second.errors.join(' | '));
    assert.equal(second.inserted, 0, 'the second live run must only update');
    assert.equal(second.updated, first.inserted + first.updated);

    const repository = createSupabaseSyncRepository({
      url: env.supabaseUrl,
      key: env.supabaseKey,
      provider: 'fixture',
      logger: silentLogger
    });
    const status = (await repository.status(5)) as {
      tables: Record<string, { rows: number }>;
      runs: unknown[];
    };
    assert.ok(status.tables.nfl_matchups.rows > 0, 'fsnv2.nfl_matchups is empty');
    assert.ok(status.runs.length > 0, 'no fsnv2.sync_runs rows came back');
  });
}

/* ----------------------------------------------------------------- report -- */

async function main(): Promise<number> {
  process.stdout.write('\u001b[1mFSN v2 — sports-data sync verification\u001b[0m\n');

  await phaseConfiguration();
  await phaseMapping();
  await phaseDatabase();
  await phaseRoute();
  await phaseLive();

  const failed = results.filter((result) => !result.ok);
  const skipped = results.filter((result) => result.skipped);
  process.stdout.write(
    `\n\u001b[1m${results.length - failed.length - skipped.length}/${results.length - skipped.length} passed\u001b[0m` +
      (skipped.length ? ` \u001b[33m(${skipped.length} skipped)\u001b[0m` : '') +
      (failed.length ? ` — \u001b[31m${failed.length} failed\u001b[0m\n` : '\n')
  );
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    process.stderr.write(`\u001b[31m${error.stack ?? error.message}\u001b[0m\n`);
    process.exit(1);
  });
