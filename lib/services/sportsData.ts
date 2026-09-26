/**
 * sportsData.ts
 * -----------------------------------------------------------------------------
 * The ingestion facade — the only module the rest of the codebase imports.
 *
 *   import { createSportsDataService } from './lib/services/sportsData.ts';
 *
 *   const service = createSportsDataService();
 *   await service.syncPlayersAndRosters();
 *   await service.syncSchedules();
 *   await service.syncWeeklyProjections(5);
 *   await service.syncBoxScores(5);
 *
 * Which vendor answers those calls is decided by `SPORTS_DATA_PROVIDER` at
 * startup (see lib/services/providers/index.ts). Callers never see a vendor's
 * field names, a vendor's error, or a vendor's rate limit: every method resolves
 * to the same SyncResult, and UI code keeps reading the database through the
 * `fsnv2_*` RPCs exactly as before.
 *
 * Each method is a *task*: it fetches, upserts in batches, writes an audit row
 * to fsnv2.sync_runs, and resolves with what happened. Expected failures — a
 * provider 500, a rate limit, a rejected batch — come back as `ok: false` with
 * `errors` populated rather than as a thrown exception, so one failing task in a
 * nightly run never aborts the others. Programmer errors (a bad week number, an
 * unknown provider, missing credentials) still throw.
 */

import type { EnvSource, SportsDataEnv } from './env.ts';
import { readEnv } from './env.ts';
import type { Logger } from './logger.ts';
import { createLogger } from './logger.ts';
import type { FetchLike } from './httpClient.ts';
import { assertWeek } from './normalize.ts';
import { resolveProvider } from './providers/index.ts';
import { createDryRunRepository, createSupabaseSyncRepository } from './syncRepository.ts';
import type {
  ProviderContext,
  ProviderDescription,
  RunStatus,
  SportsDataProvider,
  SportsDataService,
  SyncOptions,
  SyncRepository,
  SyncResult,
  SyncTask,
  UpsertCount
} from './types.ts';

export interface SportsDataServiceOptions {
  /** Fully-resolved env, or a partial patch over the process environment. */
  env?: SportsDataEnv | Partial<SportsDataEnv>;
  envSource?: EnvSource;
  logger?: Logger;
  /** Injected transport for the provider (fixtures, a recorded cassette, tests). */
  fetch?: FetchLike;
  provider?: SportsDataProvider;
  repository?: SyncRepository;
  now?: () => number;
}

interface TaskOutcome {
  fetched: number;
  counts: UpsertCount[];
  detail?: Record<string, unknown>;
}

function isFullEnv(env: SportsDataEnv | Partial<SportsDataEnv> | undefined): env is SportsDataEnv {
  return Boolean(env && 'endpoints' in env && 'provider' in env && 'batchSize' in env);
}

function sumCounts(counts: UpsertCount[]): UpsertCount {
  return counts.reduce(
    (total, count) => ({
      inserted: total.inserted + count.inserted,
      updated: total.updated + count.updated,
      skipped: total.skipped + count.skipped,
      total: total.total + count.total
    }),
    { inserted: 0, updated: 0, skipped: 0, total: 0 }
  );
}

export function createSportsDataService(
  options: SportsDataServiceOptions = {}
): SportsDataService {
  const env: SportsDataEnv = isFullEnv(options.env)
    ? options.env
    : { ...readEnv(options.envSource), ...(options.env ?? {}) };

  const logger =
    options.logger ??
    createLogger({
      level: env.logLevel,
      json: env.logJson,
      bindings: { provider: env.provider }
    });

  const provider =
    options.provider ?? resolveProvider({ env, logger, fetch: options.fetch });

  const now = options.now ?? (() => Date.now());

  /** Lazily built so a dry run (or an injected repo) never needs credentials. */
  let liveRepository: SyncRepository | null = options.repository ?? null;
  const dryRepository = createDryRunRepository(logger);

  function repositoryFor(taskOptions: SyncOptions | undefined): SyncRepository {
    // A dry run never writes, whatever repository was injected.
    if (taskOptions?.dryRun || env.dryRun) return dryRepository;
    if (options.repository) return options.repository;
    if (!liveRepository) {
      if (env.supabaseKeySource === 'publishable') {
        logger.warn(
          'using a publishable Supabase key — the sync RPCs are granted to service_role only',
          { url: env.supabaseUrl }
        );
      }
      liveRepository = createSupabaseSyncRepository({
        url: env.supabaseUrl,
        key: env.supabaseKey,
        provider: provider.name,
        batchSize: env.batchSize,
        maxRetries: env.maxRetries,
        retryBaseMs: env.retryBaseMs,
        timeoutMs: env.timeoutMs,
        logger
      });
    }
    return liveRepository;
  }

  function contextFor(taskOptions: SyncOptions | undefined, week?: number): ProviderContext {
    return {
      season: taskOptions?.season ?? env.season,
      seasonType: taskOptions?.seasonType ?? env.seasonType,
      scoringFormat: taskOptions?.scoringFormat ?? env.scoringFormat,
      week
    };
  }

  /**
   * Timing, logging, the audit row and error containment — the parts every task
   * shares, in one place so each sync method reads as just its own steps.
   */
  async function runTask(
    task: SyncTask,
    context: ProviderContext,
    repository: SyncRepository,
    steps: () => Promise<TaskOutcome>
  ): Promise<SyncResult> {
    const startedAt = now();
    const log = logger.child({ task, season: context.season, week: context.week ?? null });
    log.info('sync started', { target: repository.target });

    const result: SyncResult = {
      task,
      provider: provider.name,
      ok: true,
      season: context.season,
      week: context.week ?? null,
      fetched: 0,
      written: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      batches: 0,
      durationMs: 0,
      errors: [],
      runId: null,
      detail: {}
    };

    try {
      const outcome = await steps();
      const totals = sumCounts(outcome.counts);
      result.fetched = outcome.fetched;
      result.inserted = totals.inserted;
      result.updated = totals.updated;
      result.skipped = totals.skipped;
      result.written = totals.inserted + totals.updated;
      result.batches = outcome.counts.length;
      result.detail = outcome.detail ?? {};
      // Rows the provider sent that no table accepted: worth seeing in the log.
      if (outcome.fetched > 0 && result.written === 0 && !env.dryRun) {
        log.warn('provider returned rows but nothing was written', { fetched: outcome.fetched });
      }
    } catch (error) {
      result.ok = false;
      result.errors.push((error as Error).message);
      log.error('sync failed', { error: (error as Error).message });
    }

    result.durationMs = now() - startedAt;

    const status: RunStatus = result.ok ? 'success' : result.written > 0 ? 'partial' : 'error';
    result.runId = await repository.logRun({
      task,
      provider: provider.name,
      status,
      season: context.season,
      week: context.week ?? null,
      fetched: result.fetched,
      written: result.written,
      skipped: result.skipped,
      duration_ms: result.durationMs,
      error: result.errors.join(' | ') || null,
      detail: { ...result.detail, batches: result.batches, target: repository.target }
    });

    if (result.ok) {
      log.info('sync finished', {
        fetched: result.fetched,
        written: result.written,
        inserted: result.inserted,
        updated: result.updated,
        skipped: result.skipped,
        ms: result.durationMs
      });
    }

    return result;
  }

  /* ---------------------------------------------------------------- the API */

  async function syncPlayersAndRosters(taskOptions: SyncOptions = {}): Promise<SyncResult> {
    const context = contextFor(taskOptions);
    const repository = repositoryFor(taskOptions);

    return runTask('players_rosters', context, repository, async () => {
      const teams = await provider.fetchTeams(context);
      const teamCounts = await repository.upsertTeams(teams);

      const players = await provider.fetchPlayers(context);
      const playerCounts = await repository.upsertPlayers(players);
      // Only a complete 32-franchise snapshot may clear old roster assignments.
      // A partial API response must never turn the missing franchises into FAs.
      const released = teams.length === 32 && players.length > 0
        ? await repository.reconcilePlayerRoster(
            players.filter((player) => player.team !== 'FA').map((player) => player.external_id)
          )
        : 0;

      return {
        fetched: teams.length + players.length,
        counts: [teamCounts, playerCounts],
        detail: {
          teams: teams.length,
          teams_written: teamCounts.inserted + teamCounts.updated,
          players: players.length,
          players_written: playerCounts.inserted + playerCounts.updated,
          players_skipped: playerCounts.skipped,
          players_released: released
        }
      };
    });
  }

  async function syncWeeklyProjections(
    week: number,
    taskOptions: SyncOptions = {}
  ): Promise<SyncResult> {
    const checked = assertWeek(week, 'week');
    const context = contextFor(taskOptions, checked);
    const repository = repositoryFor(taskOptions);

    return runTask('weekly_projections', context, repository, async () => {
      const rows = await provider.fetchProjections(context);
      const counts = await repository.upsertProjections(rows);
      return {
        fetched: rows.length,
        counts: [counts],
        detail: { scoring_format: context.scoringFormat, season_type: context.seasonType }
      };
    });
  }

  async function syncBoxScores(week: number, taskOptions: SyncOptions = {}): Promise<SyncResult> {
    const checked = assertWeek(week, 'week');
    const context = contextFor(taskOptions, checked);
    const repository = repositoryFor(taskOptions);

    return runTask('box_scores', context, repository, async () => {
      const rows = await provider.fetchBoxScores(context);
      const counts = await repository.upsertWeeklyStats(rows);
      const games = new Set(rows.map((row) => row.game_external_id).filter(Boolean));
      return {
        fetched: rows.length,
        counts: [counts],
        detail: { games: games.size, scoring_format: context.scoringFormat }
      };
    });
  }

  async function syncSchedules(
    taskOptions: SyncOptions & { weeks?: number[] | number } = {}
  ): Promise<SyncResult> {
    const requested =
      taskOptions.weeks === undefined
        ? undefined
        : (Array.isArray(taskOptions.weeks) ? taskOptions.weeks : [taskOptions.weeks]).map((week) =>
            assertWeek(week, 'weeks[]')
          );

    const context: ProviderContext = { ...contextFor(taskOptions), weeks: requested };
    const repository = repositoryFor(taskOptions);

    return runTask('schedules', context, repository, async () => {
      const games = await provider.fetchSchedules(context);
      const counts = await repository.upsertSchedules(games);
      const weeks = [...new Set(games.map((game) => game.week))].sort((a, b) => a - b);
      return {
        fetched: games.length,
        counts: [counts],
        detail: { weeks, week_count: weeks.length, requested_weeks: requested ?? 'all' }
      };
    });
  }

  async function healthCheck(): Promise<{
    ok: boolean;
    provider: string;
    teams: number;
    errors: string[];
  }> {
    try {
      const teams = await provider.fetchTeams(contextFor({}));
      const ok = teams.length > 0;
      if (!ok) logger.warn('health check: provider returned no teams');
      return { ok, provider: provider.name, teams: teams.length, errors: [] };
    } catch (error) {
      logger.error('health check failed', { error: (error as Error).message });
      return { ok: false, provider: provider.name, teams: 0, errors: [(error as Error).message] };
    }
  }

  function describe(): ProviderDescription {
    return provider.describe();
  }

  return {
    provider: provider.name,
    describe,
    healthCheck,
    syncPlayersAndRosters,
    syncWeeklyProjections,
    syncBoxScores,
    syncSchedules
  };
}

let singleton: SportsDataService | null = null;

/**
 * The process-wide default service, built from the environment on first use.
 * Handy for a cron entrypoint; tests and the CLI build their own instead.
 */
export function getSportsDataService(): SportsDataService {
  if (!singleton) singleton = createSportsDataService();
  return singleton;
}

/** Drops the memoised default — call after changing env vars in a test. */
export function resetSportsDataService(): void {
  singleton = null;
}

export { readEnv } from './env.ts';
export { createLogger } from './logger.ts';
export { listProviders, registerProvider, resolveProvider } from './providers/index.ts';
export {
  createDryRunRepository,
  createSupabaseSyncRepository,
  RpcError
} from './syncRepository.ts';
export type {
  GameRow,
  PlayerRow,
  ProjectionRow,
  ProviderContext,
  SportsDataProvider,
  SportsDataService,
  SyncOptions,
  SyncRepository,
  SyncResult,
  SyncTask,
  TeamRow,
  WeeklyStatRow
} from './types.ts';
