#!/usr/bin/env node
/**
 * scripts/sync-data.ts
 * -----------------------------------------------------------------------------
 * The operational entrypoint — what a cron job, a GitHub Action or a worker
 * calls. Node 22+ runs TypeScript directly, so there is still no build step.
 *
 *   node scripts/sync-data.ts players
 *   node scripts/sync-data.ts projections boxscores --week=3
 *   node scripts/sync-data.ts schedules --weeks=1,2,3
 *   node scripts/sync-data.ts all --week=3
 *   node scripts/sync-data.ts all --week=3 --dry-run       # fetch + map, write nothing
 *   SPORTS_DATA_PROVIDER=fixture node scripts/sync-data.ts all --week=3
 *
 * Exit code is 0 only if every task it ran succeeded.
 */

import { createSportsDataService } from '../lib/services/sportsData.ts';
import { readEnv } from '../lib/services/env.ts';
import { createLogger } from '../lib/services/logger.ts';
import { listProviders } from '../lib/services/providers/index.ts';
import type { SyncResult } from '../lib/services/types.ts';

type TaskName = 'players' | 'projections' | 'boxscores' | 'schedules';

const ALL_TASKS: TaskName[] = ['players', 'schedules', 'projections', 'boxscores'];

interface Args {
  tasks: TaskName[];
  week?: number;
  weeks?: number[];
  season?: number;
  provider?: string;
  dryRun: boolean;
  json: boolean;
  logLevel?: string;
  help: boolean;
}

function usage(): string {
  return [
    'Usage: node scripts/sync-data.ts <task…> [options]',
    '',
    `Tasks:    ${ALL_TASKS.join(' | ')} | all`,
    'Options:  --week=N  --weeks=1,2,3  --season=YYYY  --provider=NAME',
    '          --dry-run  --json  --log-level=debug|info|warn|error',
    '',
    `Providers registered: ${listProviders().join(', ')}`,
    'Env:      SPORTS_DATA_PROVIDER, SPORTS_DATA_API_KEY, SPORTS_DATA_API_HOST,',
    '          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (see .env.example)'
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const args: Args = { tasks: [], dryRun: false, json: false, help: false };

  for (const token of argv) {
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--dry-run') {
      args.dryRun = true;
    } else if (token === '--json') {
      args.json = true;
    } else if (token.startsWith('--week=')) {
      args.week = Number.parseInt(token.slice(7), 10);
    } else if (token.startsWith('--weeks=')) {
      args.weeks = token
        .slice(8)
        .split(',')
        .map((part) => Number.parseInt(part.trim(), 10));
    } else if (token.startsWith('--season=')) {
      args.season = Number.parseInt(token.slice(9), 10);
    } else if (token.startsWith('--provider=')) {
      args.provider = token.slice(11);
    } else if (token.startsWith('--log-level=')) {
      args.logLevel = token.slice(12);
    } else if (token === 'all') {
      args.tasks = [...ALL_TASKS];
    } else if ((ALL_TASKS as string[]).includes(token)) {
      args.tasks.push(token as TaskName);
    } else {
      throw new Error(`Unknown argument "${token}".\n\n${usage()}`);
    }
  }

  return args;
}

function line(result: SyncResult): string {
  const mark = result.ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  const week = result.week === null ? '—' : String(result.week);
  return (
    `  ${mark} ${result.task.padEnd(19)} week ${week.padStart(2)}  ` +
    `fetched ${String(result.fetched).padStart(5)}  ` +
    `written ${String(result.written).padStart(5)}  ` +
    `(+${result.inserted} ~${result.updated} skip ${result.skipped})  ` +
    `${result.durationMs}ms` +
    (result.errors.length ? `\n      ${result.errors.join('\n      ')}` : '')
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.tasks.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return args.help ? 0 : 1;
  }

  const env = {
    ...readEnv(),
    ...(args.provider ? { provider: args.provider.toLowerCase() } : {}),
    ...(args.season ? { season: args.season } : {}),
    ...(args.logLevel ? { logLevel: args.logLevel } : {}),
    ...(args.dryRun ? { dryRun: true } : {})
  };

  const logger = createLogger({ level: env.logLevel, json: env.logJson });
  const service = createSportsDataService({ env, logger });
  const description = service.describe();

  logger.info('sports-data sync', {
    provider: description.name,
    host: description.host ?? 'n/a',
    season: env.season,
    dry_run: env.dryRun,
    target: env.dryRun ? 'dry-run' : env.supabaseUrl
  });

  const needsWeek = args.tasks.some((task) => task === 'projections' || task === 'boxscores');
  if (needsWeek && !args.week) {
    throw new Error('--week=N is required for the projections and boxscores tasks.');
  }

  const results: SyncResult[] = [];
  for (const task of args.tasks) {
    // Sequential on purpose: providers rate-limit, and players must land before
    // the rows that reference them.
    /* eslint-disable no-await-in-loop */
    switch (task) {
      case 'players':
        results.push(await service.syncPlayersAndRosters());
        break;
      case 'schedules':
        results.push(await service.syncSchedules({ weeks: args.weeks ?? args.week }));
        break;
      case 'projections':
        results.push(await service.syncWeeklyProjections(args.week as number));
        break;
      case 'boxscores':
        results.push(await service.syncBoxScores(args.week as number));
        break;
    }
    /* eslint-enable no-await-in-loop */
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    process.stdout.write('\nResults\n');
    for (const result of results) process.stdout.write(`${line(result)}\n`);
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} task(s) succeeded\n`
  );
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    process.stderr.write(`\u001b[31m${error.message}\u001b[0m\n`);
    process.exit(1);
  });
