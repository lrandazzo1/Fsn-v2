#!/usr/bin/env node
/**
 * scripts/audit-players.ts
 * -----------------------------------------------------------------------------
 * Reconciles `fsnv2.players` against nflverse and repairs what has drifted:
 * wrong franchises, several spellings of the same franchise, missing headshots,
 * missing cross-feed ids.
 *
 *   node scripts/audit-players.ts --dry-run            # report, write nothing
 *   node scripts/audit-players.ts                      # apply
 *   node scripts/audit-players.ts --refresh-headshots  # re-point every portrait
 *   node scripts/audit-players.ts --only=headshots     # one column at a time
 *   node scripts/audit-players.ts --sql-out=audit.sql  # emit SQL, write nothing
 *   node scripts/audit-players.ts --static=js/playerData.js
 *   node scripts/audit-players.ts --report=audit.json --verbose
 *
 * What it does, in order:
 *
 *   1. Loads the reference dataset from nflverse — the weekly rosters for who is
 *      on which team *now*, the season roster to cover anyone the weekly file has
 *      not listed, and players.csv for the id crosswalk (lib/services/nflverse.ts).
 *   2. Reads every row of `fsnv2.players`, hand-maintained ones included.
 *   3. Matches each row on espn_id -> sleeper_id -> gsis_id -> rotowire_id ->
 *      normalized name+position, and team defenses on their franchise
 *      (lib/services/playerIdentity.ts).
 *   4. Writes the diff through `public.fsnv2_apply_player_audit`, per column.
 *
 * `--static` additionally rewrites the team codes in js/playerData.js. That file
 * is not decoration: js/persistence.js pushes it into the table on every draft
 * board load, so a team left stale there is re-applied to the database the next
 * time anyone opens the app. Migration 0006 stops it overwriting a verified
 * assignment, but correcting the file is what stops the two disagreeing at all.
 *
 * Exit code: 0 when the audit completed (with or without changes), 1 on failure.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see .env.example). The write RPCs
 * are granted to service_role only, so a publishable key is refused by Postgres.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { currentSeason, readEnv } from '../lib/services/env.ts';
import { createLogger } from '../lib/services/logger.ts';
import { fetchNflversePlayers } from '../lib/services/nflverse.ts';
import {
  buildReferenceIndex,
  reconcilePlayers,
  toUpdatePayload
} from '../lib/services/playerIdentity.ts';
import { createSupabaseSyncRepository } from '../lib/services/syncRepository.ts';
import { canonicalTeam, normalizeTeam } from '../lib/services/teams.ts';
import { normalizePlayerName } from '../lib/services/normalize.ts';
import type { NflverseDataset } from '../lib/services/nflverse.ts';
import type { PlayerAuditChange, ReconcileOptions, ReconcileReport } from '../lib/services/playerIdentity.ts';
import type { PlayerAuditApplyCount, PlayerAuditRow } from '../lib/services/types.ts';

/* ------------------------------------------------------------------- args -- */

interface Args {
  dryRun: boolean;
  refreshHeadshots: boolean;
  only: 'all' | 'teams' | 'headshots' | 'ids';
  season?: number;
  limit?: number;
  cacheDir?: string | null;
  refresh: boolean;
  baseUrl?: string;
  sqlOut?: string;
  snapshot?: string;
  report?: string;
  staticFile?: string;
  json: boolean;
  verbose: boolean;
  preferPublishedHeadshots: boolean;
  includeJersey: boolean;
  logLevel?: string;
  help: boolean;
}

function usage(): string {
  return [
    'Usage: node scripts/audit-players.ts [options]',
    '',
    'Reconciles fsnv2.players against the nflverse reference dataset.',
    '',
    'Options:',
    '  --dry-run                 report the diff, write nothing',
    '  --only=teams|headshots|ids   restrict which columns may change',
    '  --refresh-headshots       re-point portraits that are already set',
    '  --published-headshots     prefer nflverse\'s own headshot over ESPN\'s combiner',
    '  --jerseys                 fill missing jersey numbers too',
    '  --season=YYYY             reference season (default: the current one)',
    '  --limit=N                 audit only the first N players (smoke test)',
    '  --base-url=URL            nflverse release base, or a mirror',
    '  --cache-dir=DIR           where downloads are cached ("none" to disable)',
    '  --refresh                 re-download even when a cached copy exists',
    '  --sql-out=FILE            write the UPDATEs as SQL instead of applying them',
    '  --snapshot=FILE           read fsnv2.players from a JSON file, not the RPC',
    '  --static=FILE             also correct the team codes in js/playerData.js',
    '  --report=FILE             write the full change list as JSON',
    '  --json                    machine-readable summary on stdout',
    '  --verbose                 print every change, not just a sample',
    '  --log-level=LEVEL         debug | info | warn | error | silent',
    '',
    'Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY'
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    refreshHeadshots: false,
    only: 'all',
    refresh: false,
    json: false,
    verbose: false,
    preferPublishedHeadshots: false,
    includeJersey: false,
    help: false
  };

  for (const token of argv) {
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--refresh-headshots') args.refreshHeadshots = true;
    else if (token === '--published-headshots') args.preferPublishedHeadshots = true;
    else if (token === '--jerseys') args.includeJersey = true;
    else if (token === '--refresh') args.refresh = true;
    else if (token === '--json') args.json = true;
    else if (token === '--verbose') args.verbose = true;
    else if (token.startsWith('--only=')) {
      const value = token.slice(7);
      if (value !== 'all' && value !== 'teams' && value !== 'headshots' && value !== 'ids') {
        throw new Error(`--only must be all, teams, headshots or ids — got "${value}"`);
      }
      args.only = value;
    } else if (token.startsWith('--season=')) args.season = Number.parseInt(token.slice(9), 10);
    else if (token.startsWith('--limit=')) args.limit = Number.parseInt(token.slice(8), 10);
    else if (token.startsWith('--base-url=')) args.baseUrl = token.slice(11);
    else if (token.startsWith('--cache-dir=')) {
      const value = token.slice(12);
      args.cacheDir = value === 'none' ? null : value;
    } else if (token.startsWith('--sql-out=')) args.sqlOut = token.slice(10);
    else if (token.startsWith('--snapshot=')) args.snapshot = token.slice(11);
    else if (token.startsWith('--report=')) args.report = token.slice(9);
    else if (token.startsWith('--static=')) args.staticFile = token.slice(9);
    else if (token.startsWith('--log-level=')) args.logLevel = token.slice(12);
    else throw new Error(`Unknown argument "${token}".\n\n${usage()}`);
  }

  return args;
}

/* ---------------------------------------------------------------- reporting -- */

const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

function describeChange(change: PlayerAuditChange): string {
  const parts = change.fields.map((field) => {
    const before = change.before[field] ?? '—';
    const after = change.after[field] ?? '—';
    if (field === 'headshot_url') return 'headshot';
    if (field === 'team') return `team ${before} → ${after}`;
    return `${field} → ${after}`;
  });
  return `${change.name.padEnd(24)} ${change.position.padEnd(4)} ${parts.join(', ')}` +
    `${DIM} [${change.match}]${RESET}`;
}

/** The headline the task asked for: "Updated N team mappings and M headshots". */
function headline(applied: PlayerAuditApplyCount, report: ReconcileReport): string {
  return (
    `Updated ${applied.teams} player team mapping${applied.teams === 1 ? '' : 's'} ` +
    `and ${applied.headshots} headshot${applied.headshots === 1 ? '' : 's'} ` +
    `(${applied.ids} identifier${applied.ids === 1 ? '' : 's'} filled, ` +
    `${report.counts.rows} players audited, ${report.unmatched.length} unmatched)`
  );
}

/* ------------------------------------------------------------------- SQL -- */

const sqlLiteral = (value: string | null): string =>
  value === null ? 'null' : `'${value.replace(/'/g, "''")}'`;

/**
 * The same diff as a SQL script, for applying by hand through the Supabase SQL
 * editor when no service-role key is available to the machine running the audit.
 */
function toSql(changes: PlayerAuditChange[], dataset: NflverseDataset): string {
  const lines: string[] = [
    '-- Generated by scripts/audit-players.ts — fsnv2.players reconciled against nflverse.',
    `-- Reference season ${dataset.season}; ${dataset.players.length} reference players.`,
    `-- Generated ${new Date().toISOString()}. ${changes.length} row(s) to update.`,
    '--',
    '-- Runs as one transaction: either the whole audit lands or none of it does.',
    'begin;'
  ];

  for (const change of changes) {
    const assignments = change.fields.map((field) => {
      const value = change.after[field] ?? null;
      // Never blank a column that already holds something.
      return field === 'team'
        ? `team = ${sqlLiteral(value)}, team_source = 'nflverse'`
        : `${field} = coalesce(${sqlLiteral(value)}, ${field})`;
    });
    lines.push(
      `-- ${change.name} (${change.position}) — matched by ${change.match}` +
        (change.notes.length ? `; ${change.notes.join('; ')}` : '')
    );
    lines.push(
      `update fsnv2.players set ${assignments.join(', ')}, audited_at = now(), updated_at = now() ` +
        `where id = ${sqlLiteral(change.id)};`
    );
  }

  lines.push('commit;');
  return `${lines.join('\n')}\n`;
}

/* ------------------------------------------------- the hand-maintained pool -- */

/**
 * Rewrites the third element of each RAW_PLAYERS tuple in js/playerData.js to the
 * reconciled team code.
 *
 * Only that one field is touched, by an anchored per-line replacement, so the
 * file's projections and its ordering (which the draft board's ids depend on:
 * `p-0007` *is* index 7) are untouched. A line whose name matches no reconciled
 * player is left exactly as it is.
 */
export function rewriteStaticPool(
  source: string,
  teamByName: Map<string, string>
): { text: string; changed: Array<{ name: string; from: string; to: string }> } {
  const changed: Array<{ name: string; from: string; to: string }> = [];
  const pattern = /^(\s*\[\s*(['"])(.*?)\2\s*,\s*(['"])([A-Z/]+)\4\s*,\s*(['"]))([A-Za-z0-9]+)(\4\s*,)/;

  const text = source
    .split('\n')
    .map((line) => {
      const match = pattern.exec(line);
      if (!match) return line;
      const [, prefix, , name, , position, , team, suffix] = match;
      const key = `${normalizePlayerName(name)}|${position}`;
      const next = teamByName.get(key);
      if (!next || next === team) return line;
      changed.push({ name, from: team, to: next });
      return `${prefix}${next}${suffix}${line.slice(match[0].length)}`;
    })
    .join('\n');

  return { text, changed };
}

/* ------------------------------------------------------------------ main -- */

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const env = readEnv();
  const logger = createLogger({
    level: args.logLevel ?? (args.json ? 'warn' : env.logLevel),
    json: env.logJson
  });
  const season = args.season ?? currentSeason();

  // Two write targets, two switches. `--dry-run` changes nothing anywhere;
  // `--sql-out` only diverts the *database* half to a file, so a run can emit
  // SQL for review and still correct the static pool in the working tree.
  const writingDb = !args.dryRun && !args.sqlOut;
  const writingFiles = !args.dryRun;
  const mode = args.dryRun ? 'dry-run' : args.sqlOut ? 'sql-out' : 'apply';

  if (!args.json) {
    process.stdout.write(`${BOLD}FSN v2 — player database audit${RESET}\n`);
    process.stdout.write(
      `${DIM}reference: nflverse ${season} · target: ${env.supabaseUrl} · mode: ${mode}${RESET}\n\n`
    );
  }

  /* 1 — the reference dataset ------------------------------------------------ */
  const dataset = await fetchNflversePlayers({
    season,
    baseUrl: args.baseUrl,
    cacheDir: args.cacheDir,
    refresh: args.refresh,
    logger,
    preferEspnHeadshots: !args.preferPublishedHeadshots
  });
  for (const warning of dataset.warnings) logger.warn(`nflverse: ${warning}`);
  const index = buildReferenceIndex(dataset.players);

  /* 2 — the database -------------------------------------------------------- */
  // A run that reads its rows from a snapshot and writes no database needs no
  // credentials at all, so it must not fail on their absence.
  const needsDatabase = !args.snapshot || writingDb;
  const repository = !needsDatabase
    ? null
    : createSupabaseSyncRepository({
        url: env.supabaseUrl,
        key: env.supabaseKey,
        provider: env.provider,
        batchSize: env.batchSize,
        maxRetries: env.maxRetries,
        retryBaseMs: env.retryBaseMs,
        timeoutMs: env.timeoutMs,
        logger
      });

  if (needsDatabase && env.supabaseKeySource !== 'secret') {
    logger.warn('no service-role key found — the audit RPCs are granted to service_role only', {
      key_source: env.supabaseKeySource
    });
  }

  // --snapshot reads the table from a file instead of the RPC, so the audit can
  // be run and reviewed on a machine that has no service-role key: export the
  // rows once (`select jsonb_agg(...) from fsnv2.players`), reconcile offline,
  // and apply the result with --sql-out through the SQL editor.
  const rows: PlayerAuditRow[] = args.snapshot
    ? (JSON.parse(await readFile(args.snapshot, 'utf8')) as PlayerAuditRow[])
    : (await repository?.playersAuditSnapshot?.(args.limit)) ?? [];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      args.snapshot
        ? `${args.snapshot} held no player rows — expected a JSON array of fsnv2.players.`
        : 'fsnv2.players returned no rows — nothing to audit.'
    );
  }
  const scoped = args.snapshot && args.limit ? rows.slice(0, args.limit) : rows;
  logger.info('player snapshot read', {
    players: scoped.length,
    source: args.snapshot ?? 'fsnv2_players_audit_snapshot'
  });

  /* 3 — reconcile ----------------------------------------------------------- */
  const options: ReconcileOptions = {
    refreshHeadshots: args.refreshHeadshots,
    preferEspnHeadshots: !args.preferPublishedHeadshots,
    skipTeams: args.only === 'headshots' || args.only === 'ids',
    skipHeadshots: args.only === 'teams' || args.only === 'ids',
    includeJersey: args.includeJersey
  };
  const report = reconcilePlayers(scoped, index, options);
  let payload = toUpdatePayload(report.changes);
  if (args.only === 'ids') {
    payload = payload.map((row) => {
      const { id, espn_id, sleeper_id, gsis_id, rotowire_id } = row;
      return { id, espn_id, sleeper_id, gsis_id, rotowire_id };
    });
  }

  if (!args.json) printPlan(report, scoped, args);

  /* 4 — write --------------------------------------------------------------- */
  let applied: PlayerAuditApplyCount = {
    matched: 0,
    updated: 0,
    missing: 0,
    total: payload.length,
    teams: 0,
    headshots: 0,
    ids: 0,
    jerseys: 0,
    dry_run: !writingDb
  };

  if (args.sqlOut) {
    await writeFile(args.sqlOut, toSql(report.changes, dataset), 'utf8');
    process.stdout.write(`${GREEN}✓${RESET} wrote ${report.changes.length} UPDATE(s) to ${args.sqlOut}\n`);
    applied = { ...applied, ...countsFromPlan(report) };
  } else {
    applied = (await repository?.applyPlayerAudit?.(payload, !writingDb)) ?? applied;
  }

  /* 5 — the hand-maintained pool -------------------------------------------- */
  let staticChanges: Array<{ name: string; from: string; to: string }> = [];
  if (args.staticFile) {
    const teamByName = new Map<string, string>();
    for (const row of scoped) {
      const change = report.changes.find((candidate) => candidate.id === row.id);
      const team = change?.after.team ?? canonicalTeam(row.team);
      if (team) teamByName.set(`${normalizePlayerName(row.name)}|${row.position}`, team);
    }
    const source = await readFile(args.staticFile, 'utf8');
    const rewritten = rewriteStaticPool(source, teamByName);
    staticChanges = rewritten.changed;
    if (staticChanges.length > 0 && writingFiles) {
      await writeFile(args.staticFile, rewritten.text, 'utf8');
    }
    if (!args.json) {
      const verb = writingFiles ? 'corrected' : 'would correct';
      process.stdout.write(
        `\n${staticChanges.length ? YELLOW : GREEN}•${RESET} ${args.staticFile}: ` +
          `${verb} ${staticChanges.length} team code(s)` +
          (staticChanges.length
            ? `\n${staticChanges
                .map((entry) => `    ${DIM}${entry.name}: ${entry.from} → ${entry.to}${RESET}`)
                .join('\n')}\n`
            : '\n')
      );
    }
  }

  /* 6 — report -------------------------------------------------------------- */
  const summary = {
    ok: true,
    mode,
    reference: {
      season: dataset.season,
      players: dataset.players.length,
      sources: dataset.sources,
      warnings: dataset.warnings
    },
    audited: report.counts,
    matches: report.byMethod,
    applied,
    unmatched: report.unmatched.map((change) => ({
      id: change.id,
      name: change.name,
      position: change.position,
      team: change.before.team ?? null
    })),
    static_pool: { file: args.staticFile ?? null, changes: staticChanges },
    headline: headline(applied, report)
  };

  if (args.report) {
    await writeFile(
      args.report,
      `${JSON.stringify({ ...summary, changes: report.changes }, null, 2)}\n`,
      'utf8'
    );
    if (!args.json) process.stdout.write(`${DIM}full change list → ${args.report}${RESET}\n`);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${BOLD}${headline(applied, report)}${RESET}\n`);
    if (!writingDb) {
      process.stdout.write(
        args.sqlOut
          ? `${DIM}the database was not touched — apply ${args.sqlOut}, or re-run without --sql-out.${RESET}\n`
          : `${DIM}nothing was written — re-run without --dry-run to apply.${RESET}\n`
      );
    }
  }

  return 0;
}

/** Counts straight from the plan, for the paths that do not round-trip the RPC. */
function countsFromPlan(report: ReconcileReport): Partial<PlayerAuditApplyCount> {
  return {
    matched: report.changes.length,
    updated: report.changes.length,
    teams: report.counts.teams,
    headshots: report.counts.headshots,
    ids: report.counts.ids,
    jerseys: report.counts.jerseys
  };
}

function printPlan(report: ReconcileReport, rows: PlayerAuditRow[], args: Args): void {
  const { counts } = report;
  process.stdout.write(
    `  players ${counts.rows}   matched ${counts.matched}   ` +
      `unmatched ${counts.rows - counts.matched}   already correct ${report.clean}\n`
  );
  process.stdout.write(
    `  ${BOLD}to change${RESET}: ${counts.teams} team${counts.teams === 1 ? '' : 's'}` +
      ` (${counts.normalizedTeamCodes} of them a spelling fix), ` +
      `${counts.headshots} headshot${counts.headshots === 1 ? '' : 's'}, ` +
      `${counts.ids} id${counts.ids === 1 ? '' : 's'}` +
      (counts.jerseys ? `, ${counts.jerseys} jersey(s)` : '') +
      '\n'
  );
  process.stdout.write(
    `  ${DIM}matched by: ${Object.entries(report.byMethod)
      .filter(([, n]) => n > 0)
      .map(([method, n]) => `${method} ${n}`)
      .join(', ')}${RESET}\n`
  );

  const teamMoves = report.changes.filter(
    (change) =>
      change.fields.includes('team') &&
      change.before.team &&
      canonicalTeam(change.before.team) !== change.after.team
  );
  if (teamMoves.length > 0) {
    process.stdout.write(`\n  ${BOLD}Team reassignments${RESET}\n`);
    const shown = args.verbose ? teamMoves : teamMoves.slice(0, 25);
    for (const change of shown) process.stdout.write(`    ${describeChange(change)}\n`);
    if (shown.length < teamMoves.length) {
      process.stdout.write(`    ${DIM}… and ${teamMoves.length - shown.length} more (--verbose)${RESET}\n`);
    }
  }

  const noted = report.changes.filter((change) => change.notes.length > 0);
  const conflicts = noted.filter((change) => change.notes.some((note) => note.includes('conflict')));
  if (conflicts.length > 0) {
    process.stdout.write(`\n  ${YELLOW}Identifier conflicts — left as stored${RESET}\n`);
    for (const change of conflicts.slice(0, args.verbose ? conflicts.length : 10)) {
      process.stdout.write(`    ${change.name}: ${change.notes.join('; ')}\n`);
    }
  }

  if (report.unmatched.length > 0) {
    process.stdout.write(
      `\n  ${YELLOW}Unmatched${RESET} ${DIM}(no reference player; team code normalized only)${RESET}\n`
    );
    const shown = args.verbose ? report.unmatched : report.unmatched.slice(0, 15);
    for (const change of shown) {
      const row = rows.find((candidate) => candidate.id === change.id);
      process.stdout.write(
        `    ${change.name.padEnd(24)} ${change.position.padEnd(4)} ` +
          `${DIM}${normalizeTeam(row?.team)}${RESET}\n`
      );
    }
    if (shown.length < report.unmatched.length) {
      process.stdout.write(
        `    ${DIM}… and ${report.unmatched.length - shown.length} more (--verbose)${RESET}\n`
      );
    }
  }
}

/**
 * Only run when this file *is* the command. The verification suite imports
 * `rewriteStaticPool` from here, and an unguarded main() would run a live audit
 * as a side effect of that import.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error: Error) => {
      process.stderr.write(`${RED}${error.stack ?? error.message}${RESET}\n`);
      process.exit(1);
    });
}
