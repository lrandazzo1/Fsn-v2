/**
 * syncRepository.ts
 * -----------------------------------------------------------------------------
 * The database half of a sync: batched UPSERTs through the `fsnv2_sync_*` RPCs.
 *
 * Design notes
 *  - Plain `fetch` against PostgREST, like js/persistence.js — no supabase-js
 *    bundle, so the same module runs under Node, in a worker, or in an edge
 *    function.
 *  - Every write is an upsert keyed on a unique constraint, so re-running a sync
 *    refreshes rows instead of duplicating them (see migration 0004).
 *  - Rows go up in batches (SPORTS_DATA_BATCH_SIZE, default 120) with retries on
 *    5xx/429, and the per-batch counts are summed so a caller can log exactly
 *    what landed.
 *  - The `rpc` transport is injectable: the CLI verifier swaps in an in-memory
 *    double (lib/services/testing/memoryRpc.ts) to check upsert semantics with
 *    no database.
 */

import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';
import { chunk } from './normalize.ts';
import type {
  GameRow,
  PlayerAuditApplyCount,
  PlayerAuditRow,
  PlayerRow,
  ProjectionRow,
  SyncRepository,
  SyncRunLog,
  TeamRow,
  UpsertCount,
  WeeklyStatRow
} from './types.ts';

export type RpcTransport = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export class RpcError extends Error {
  rpc: string;
  status: number;
  body: string;

  constructor(rpc: string, status: number, body: string) {
    super(`${rpc} failed (${status})${body ? `: ${body}` : ''}`);
    this.name = 'RpcError';
    this.rpc = rpc;
    this.status = status;
    this.body = body;
  }
}

export interface SupabaseSyncRepositoryOptions {
  url?: string;
  key?: string;
  provider: string;
  batchSize?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  timeoutMs?: number;
  logger?: Logger;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Replaces PostgREST entirely (tests, a pg-backed worker). */
  rpc?: RpcTransport;
  sleep?: (ms: number) => Promise<void>;
}

const EMPTY: UpsertCount = { inserted: 0, updated: 0, skipped: 0, total: 0 };

function addCounts(a: UpsertCount, b: UpsertCount): UpsertCount {
  return {
    inserted: a.inserted + b.inserted,
    updated: a.updated + b.updated,
    skipped: a.skipped + b.skipped,
    total: a.total + b.total
  };
}

/** Coerces whatever an RPC returned into a count, so a shape change is loud. */
function toCount(rpc: string, payload: unknown, total: number): UpsertCount {
  if (!payload || typeof payload !== 'object') {
    throw new RpcError(rpc, 200, `expected an upsert count object, got ${JSON.stringify(payload)}`);
  }
  const row = payload as Record<string, unknown>;
  const read = (key: string): number => {
    const value = row[key];
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? 0), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    inserted: read('inserted'),
    updated: read('updated'),
    skipped: read('skipped'),
    total: read('total') || total
  };
}

export function createSupabaseSyncRepository(
  options: SupabaseSyncRepositoryOptions
): SyncRepository {
  const logger = options.logger ?? silentLogger;
  const batchSize = Math.max(1, options.batchSize ?? 120);
  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const retryBaseMs = Math.max(0, options.retryBaseMs ?? 500);
  const timeoutMs = options.timeoutMs ?? 20000;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((done) => {
        setTimeout(done, ms);
      }));

  const injected = options.rpc;
  const url = (options.url ?? '').replace(/\/+$/, '');
  const key = options.key ?? '';
  const doFetch: NonNullable<SupabaseSyncRepositoryOptions['fetch']> | undefined =
    options.fetch ?? (globalThis.fetch as SupabaseSyncRepositoryOptions['fetch']);

  if (!injected && (!url || !key)) {
    throw new Error(
      'Supabase credentials missing: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or pass options.rpc).'
    );
  }

  async function postRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (injected) return injected(name, args);
    if (!doFetch) throw new Error('No fetch implementation available for PostgREST.');

    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(`${url}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: key,
            Authorization: `Bearer ${key}`
          },
          body: JSON.stringify(args),
          signal: controller.signal
        });

        if (!response.ok) {
          const body = (await response.text().catch(() => '')).slice(0, 500);
          const retryable = response.status === 429 || response.status >= 500;
          if (retryable && attempt < maxRetries) {
            const delay = retryBaseMs * 2 ** attempt;
            logger.warn('rpc failed, retrying', {
              rpc: name,
              status: response.status,
              attempt: attempt + 1,
              delay_ms: delay
            });
            attempt += 1;
            await sleep(delay);
            continue;
          }
          throw new RpcError(name, response.status, body);
        }

        const raw = await response.text();
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        if (error instanceof RpcError || attempt >= maxRetries) throw error;
        const delay = retryBaseMs * 2 ** attempt;
        logger.warn('rpc errored, retrying', {
          rpc: name,
          attempt: attempt + 1,
          delay_ms: delay,
          error: (error as Error).message
        });
        attempt += 1;
        await sleep(delay);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** Runs one RPC per batch and sums the counts. */
  async function upsertBatched<T>(
    rpc: string,
    argName: string,
    rows: T[]
  ): Promise<UpsertCount> {
    if (rows.length === 0) {
      logger.debug('nothing to upsert', { rpc });
      return { ...EMPTY };
    }

    let totals: UpsertCount = { ...EMPTY };
    const batches = chunk(rows, batchSize);
    for (const [index, batch] of batches.entries()) {
      // Sequential: one in-flight write keeps the row order deterministic and
      // stays inside Supabase's connection budget.
      // eslint-disable-next-line no-await-in-loop
      const payload = await postRpc(rpc, {
        p_provider: options.provider,
        [argName]: batch
      });
      const count = toCount(rpc, payload, batch.length);
      totals = addCounts(totals, count);
      logger.debug('batch upserted', {
        rpc,
        batch: `${index + 1}/${batches.length}`,
        ...count
      });
    }
    logger.info('upsert complete', { rpc, ...totals });
    return totals;
  }

  return {
    target: injected ? 'injected-rpc' : url,
    upsertTeams: (rows: TeamRow[]) => upsertBatched('fsnv2_sync_nfl_teams', 'p_teams', rows),
    upsertPlayers: (rows: PlayerRow[]) => upsertBatched('fsnv2_sync_players', 'p_players', rows),
    upsertProjections: (rows: ProjectionRow[]) =>
      upsertBatched('fsnv2_sync_projections', 'p_rows', rows),
    upsertWeeklyStats: (rows: WeeklyStatRow[]) =>
      upsertBatched('fsnv2_sync_weekly_stats', 'p_rows', rows),
    upsertSchedules: (rows: GameRow[]) => upsertBatched('fsnv2_sync_schedules', 'p_games', rows),

    async logRun(entry: SyncRunLog): Promise<string | null> {
      try {
        const id = await postRpc('fsnv2_log_sync_run', {
          p_task: entry.task,
          p_provider: entry.provider,
          p_status: entry.status,
          p_season: entry.season ?? null,
          p_week: entry.week ?? null,
          p_fetched: entry.fetched ?? 0,
          p_written: entry.written ?? 0,
          p_skipped: entry.skipped ?? 0,
          p_duration_ms: entry.duration_ms ?? null,
          p_error: entry.error ?? null,
          p_detail: entry.detail ?? {}
        });
        return typeof id === 'string' ? id : null;
      } catch (error) {
        // An audit row is never worth failing a sync over — log and move on.
        logger.warn('could not write the sync_runs audit row', {
          task: entry.task,
          error: (error as Error).message
        });
        return null;
      }
    },

    status: (limit = 10) => postRpc('fsnv2_sync_status', { p_limit: limit }),

    /* ------------------------------------------------------- player audit -- */

    /** Every `fsnv2.players` row the audit reconciles, hand-maintained ones included. */
    async playersAuditSnapshot(limit?: number): Promise<PlayerAuditRow[]> {
      const payload = await postRpc('fsnv2_players_audit_snapshot', { p_limit: limit ?? null });
      if (!Array.isArray(payload)) {
        throw new RpcError(
          'fsnv2_players_audit_snapshot',
          200,
          `expected an array of players, got ${typeof payload}`
        );
      }
      return payload as PlayerAuditRow[];
    },

    /**
     * Applies a reconciled plan in batches. `dryRun` routes to the read-only
     * preview RPC, so the reported counts come from the same diff the write
     * would perform rather than from the script's own arithmetic.
     */
    async applyPlayerAudit(
      rows: Array<Record<string, string | null>>,
      dryRun = false
    ): Promise<PlayerAuditApplyCount> {
      const totals: PlayerAuditApplyCount = {
        matched: 0,
        updated: 0,
        missing: 0,
        total: 0,
        teams: 0,
        headshots: 0,
        ids: 0,
        jerseys: 0,
        dry_run: dryRun
      };
      if (rows.length === 0) return totals;

      const batches = chunk(rows, batchSize);
      for (const [index, batch] of batches.entries()) {
        // eslint-disable-next-line no-await-in-loop
        const payload = await postRpc('fsnv2_apply_player_audit', {
          p_rows: batch,
          p_dry_run: dryRun
        });
        const counts = (payload ?? {}) as Record<string, unknown>;
        const read = (key: string): number => {
          const value = counts[key];
          const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? 0), 10);
          return Number.isFinite(parsed) ? parsed : 0;
        };
        for (const key of ['matched', 'updated', 'missing', 'total', 'teams', 'headshots', 'ids', 'jerseys'] as const) {
          totals[key] += read(key);
        }
        logger.debug('audit batch applied', {
          batch: `${index + 1}/${batches.length}`,
          updated: read('updated'),
          dry_run: dryRun
        });
      }
      logger.info(dryRun ? 'audit preview complete' : 'audit applied', { ...totals });
      return totals;
    },

    auditStatus: () => postRpc('fsnv2_player_audit_status', {})
  };
}

/**
 * A repository that counts rows and writes nothing — `--dry-run`. Useful for
 * checking a provider's output (and a mapping change) against production data
 * without touching the database.
 */
export function createDryRunRepository(logger: Logger = silentLogger): SyncRepository {
  const count = (rows: unknown[]): Promise<UpsertCount> => {
    logger.info('dry run — not writing', { rows: rows.length });
    return Promise.resolve({ inserted: 0, updated: 0, skipped: rows.length, total: rows.length });
  };

  return {
    target: 'dry-run',
    upsertTeams: count,
    upsertPlayers: count,
    upsertProjections: count,
    upsertWeeklyStats: count,
    upsertSchedules: count,
    logRun: () => Promise.resolve(null),
    status: () => Promise.resolve({ dryRun: true })
  };
}
