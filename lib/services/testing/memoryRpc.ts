/**
 * testing/memoryRpc.ts
 * -----------------------------------------------------------------------------
 * An in-memory stand-in for the `fsnv2_sync_*` RPCs, mirroring what migration
 * 0004 does: the same unique keys, the same inserted/updated/skipped counts, the
 * same validation errors.
 *
 * It exists so `npm run test:sync-data` can prove the *write path* — batching,
 * conflict keys, idempotency, audit rows — on a machine with no database and no
 * credentials, and still exit 0. When Supabase credentials are present the same
 * verifier runs against the real project instead, and both must agree.
 *
 * Test support only: nothing in the service imports this.
 */

import type { RpcTransport } from '../syncRepository.ts';

interface Store {
  teams: Map<string, Record<string, unknown>>;
  players: Map<string, Record<string, unknown>>;
  projections: Map<string, Record<string, unknown>>;
  weeklyStats: Map<string, Record<string, unknown>>;
  schedules: Map<string, Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
}

export interface MemoryRpc {
  rpc: RpcTransport;
  store: Store;
  calls: Array<{ name: string; rows: number }>;
  reset(): void;
}

const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);

function rows(args: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const value = args[key];
  if (!Array.isArray(value)) {
    throw new Error(
      `${key} must be a jsonb array, got ${value === undefined ? 'null' : typeof value}`
    );
  }
  return value as Array<Record<string, unknown>>;
}

function requireProvider(name: string, args: Record<string, unknown>): string {
  const provider = args.p_provider;
  if (typeof provider !== 'string' || provider === '') {
    throw new Error(`${name}: provider is required`);
  }
  return provider;
}

function missing(row: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => {
    const value = row[key];
    return value === undefined || value === null || String(value) === '';
  });
}

function upsert(
  table: Map<string, Record<string, unknown>>,
  batch: Array<Record<string, unknown>>,
  keyOf: (row: Record<string, unknown>) => string | null,
  merge: (existing: Record<string, unknown> | undefined, row: Record<string, unknown>) => Record<string, unknown>
): { inserted: number; updated: number; skipped: number; total: number } {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for (const row of batch) {
    const key = keyOf(row);
    if (key === null || seen.has(key)) {
      // Unsupported position, or a duplicate inside the same batch — exactly
      // what `distinct on (...)` and the position filter drop in SQL.
      skipped += 1;
      continue;
    }
    seen.add(key);
    const existing = table.get(key);
    table.set(key, merge(existing, row));
    if (existing) updated += 1;
    else inserted += 1;
  }

  return { inserted, updated, skipped, total: batch.length };
}

export function createMemoryRpc(): MemoryRpc {
  const store: Store = {
    teams: new Map(),
    players: new Map(),
    projections: new Map(),
    weeklyStats: new Map(),
    schedules: new Map(),
    runs: []
  };
  const calls: Array<{ name: string; rows: number }> = [];

  const rpc: RpcTransport = async (name, args) => {
    switch (name) {
      case 'fsnv2_sync_nfl_teams': {
        const provider = requireProvider(name, args);
        const batch = rows(args, 'p_teams');
        calls.push({ name, rows: batch.length });
        const bad = batch.filter((row) => missing(row, ['external_id', 'abbr'])).length;
        if (bad) throw new Error(`${name}: ${bad} row(s) missing external_id or abbr`);
        return upsert(
          store.teams,
          batch,
          (row) => `${provider}:${row.external_id}`,
          (existing, row) => ({ ...existing, ...row, provider })
        );
      }

      case 'fsnv2_sync_players': {
        const provider = requireProvider(name, args);
        const batch = rows(args, 'p_players');
        calls.push({ name, rows: batch.length });
        const bad = batch.filter((row) => missing(row, ['external_id', 'name'])).length;
        if (bad) throw new Error(`${name}: ${bad} row(s) missing external_id or name`);
        return upsert(
          store.players,
          batch,
          (row) =>
            FANTASY_POSITIONS.has(String(row.position ?? '').toUpperCase())
              ? `${provider}:${row.external_id}`
              : null,
          (existing, row) => ({
            ...existing,
            ...row,
            id: row.id ?? `${provider}-${String(row.external_id)}`,
            provider
          })
        );
      }

      case 'fsnv2_sync_projections': {
        const provider = requireProvider(name, args);
        const batch = rows(args, 'p_rows');
        calls.push({ name, rows: batch.length });
        const bad = batch.filter((row) =>
          missing(row, ['external_player_id', 'season', 'week'])
        ).length;
        if (bad) {
          throw new Error(`${name}: ${bad} row(s) missing external_player_id, season or week`);
        }
        return upsert(
          store.projections,
          batch,
          (row) =>
            [
              provider,
              row.season,
              row.season_type ?? 'reg',
              row.week,
              row.scoring_format ?? 'ppr',
              row.external_player_id
            ].join(':'),
          (existing, row) => ({ ...existing, ...row, provider })
        );
      }

      case 'fsnv2_sync_weekly_stats': {
        const provider = requireProvider(name, args);
        const batch = rows(args, 'p_rows');
        calls.push({ name, rows: batch.length });
        const bad = batch.filter((row) =>
          missing(row, ['external_player_id', 'season', 'week'])
        ).length;
        if (bad) {
          throw new Error(`${name}: ${bad} row(s) missing external_player_id, season or week`);
        }
        return upsert(
          store.weeklyStats,
          batch,
          (row) =>
            [provider, row.season, row.season_type ?? 'reg', row.week, row.external_player_id].join(
              ':'
            ),
          (existing, row) => ({ ...existing, ...row, provider })
        );
      }

      case 'fsnv2_sync_schedules': {
        const provider = requireProvider(name, args);
        const batch = rows(args, 'p_games');
        calls.push({ name, rows: batch.length });
        const bad = batch.filter(
          (row) =>
            missing(row, ['external_id', 'season', 'week', 'home_team', 'away_team']) ||
            String(row.home_team).toUpperCase() === String(row.away_team).toUpperCase()
        ).length;
        if (bad) {
          throw new Error(
            `${name}: ${bad} game(s) missing external_id/season/week/teams or playing themselves`
          );
        }
        return upsert(
          store.schedules,
          batch,
          (row) => `${provider}:${row.external_id}`,
          (existing, row) => ({ ...existing, ...row, provider })
        );
      }

      case 'fsnv2_log_sync_run': {
        calls.push({ name, rows: 1 });
        const id = `run-${store.runs.length + 1}`;
        store.runs.push({ id, ...args, finished_at: new Date().toISOString() });
        return id;
      }

      case 'fsnv2_sync_status': {
        calls.push({ name, rows: 0 });
        return {
          tables: {
            players: { rows: store.players.size },
            nfl_teams: { rows: store.teams.size },
            projections: { rows: store.projections.size },
            weekly_stats: { rows: store.weeklyStats.size },
            nfl_matchups: { rows: store.schedules.size }
          },
          runs: store.runs.slice(-Number(args.p_limit ?? 10)).reverse()
        };
      }

      default:
        throw new Error(`memoryRpc: unexpected rpc "${name}"`);
    }
  };

  return {
    rpc,
    store,
    calls,
    reset() {
      store.teams.clear();
      store.players.clear();
      store.projections.clear();
      store.weeklyStats.clear();
      store.schedules.clear();
      store.runs.length = 0;
      calls.length = 0;
    }
  };
}
