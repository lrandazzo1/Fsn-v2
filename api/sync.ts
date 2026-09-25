/**
 * api/sync.ts  —  GET|POST /api/sync
 * -----------------------------------------------------------------------------
 * The scheduled entrypoint for the ingestion service. `vercel.json` points a
 * weekly Cron Job at this route; it is also callable by hand to backfill a week.
 *
 *   /api/sync                              the weekly bundle (what cron runs)
 *   /api/sync?task=players
 *   /api/sync?task=projections&week=3
 *   /api/sync?task=boxscores&week=2&season=2026
 *   /api/sync?task=schedules&weeks=1,2,3
 *   /api/sync?task=all&week=3&dry_run=1    fetch + map, write nothing
 *
 * The weekly bundle works out which weeks matter from the calendar — kickoff is
 * the Thursday after Labor Day, and a week's games run Thursday through Monday
 * night — then runs:
 *
 *   players     → fsnv2.nfl_teams + fsnv2.players
 *   schedules   → fsnv2.nfl_matchups, a three-week window
 *   projections → fsnv2.projections for the next week to be played
 *   boxscores   → fsnv2.weekly_stats for the most recent finished week
 *
 * So the Tuesday run projects the week ahead and ingests the week just played,
 * while a mid-week run projects the week in progress instead.
 *
 * Tasks run in order and stop starting new work near the function's time limit,
 * so a slow provider degrades into "some tasks skipped" rather than a hard
 * timeout with no audit trail. Whatever did run is in the response and in
 * fsnv2.sync_runs.
 *
 * Auth: set `CRON_SECRET` in the project's environment variables. Vercel sends
 * it as `Authorization: Bearer $CRON_SECRET` on cron invocations; anything else
 * needs the same header (or `?secret=`). With no CRON_SECRET configured the
 * route still answers — the project's Vercel Authentication is then the only
 * thing in front of it — and says so in the payload.
 */

import { createSportsDataService } from '../lib/services/sportsData.ts';
import { currentSeason, readEnv, weekFocus } from '../lib/services/env.ts';
import { createLogger } from '../lib/services/logger.ts';
import type { Logger } from '../lib/services/logger.ts';
import type { SportsDataEnv, WeekFocus } from '../lib/services/env.ts';
import type { SportsDataService, SyncResult } from '../lib/services/types.ts';

type TaskName = 'players' | 'schedules' | 'projections' | 'boxscores';

interface PlannedTask {
  task: TaskName;
  week?: number;
  weeks?: number[];
}

export interface SyncRequestOptions {
  env?: SportsDataEnv;
  logger?: Logger;
  service?: SportsDataService;
  now?: Date;
  /** Stop starting tasks after this many ms (default: just under maxDuration). */
  budgetMs?: number;
}

const ALL_TASKS: TaskName[] = ['players', 'schedules', 'projections', 'boxscores'];

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function parseWeek(value: string | null, label: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 22) {
    throw new TypeError(`${label} must be an integer between 1 and 22, got "${value}"`);
  }
  return parsed;
}

/**
 * Cron invocations carry the secret as a bearer token. A missing CRON_SECRET is
 * reported rather than treated as authorisation to lock everyone out: the route
 * is only reachable through the project's protection until one is set.
 */
function authorize(
  request: Request,
  secret: string
): { ok: boolean; warning?: string } {
  if (!secret) {
    return {
      ok: true,
      warning:
        'CRON_SECRET is not set — this route is protected only by the project’s deployment protection. Add CRON_SECRET in the Vercel project settings.'
    };
  }

  const header = request.headers.get('authorization') ?? '';
  const url = new URL(request.url);
  const presented = header.startsWith('Bearer ')
    ? header.slice(7)
    : (url.searchParams.get('secret') ?? '');

  return { ok: presented === secret };
}

/** What a scheduled run does, given which weeks the calendar says matter. */
export function weeklyPlan(focus: WeekFocus): PlannedTask[] {
  // The regular season is 18 weeks; a post-season backfill is run explicitly
  // with ?task=schedules&weeks=…
  const window = [...new Set([focus.upcoming - 1, focus.upcoming, focus.upcoming + 1])].filter(
    (value) => value >= 1 && value <= 18
  );

  const plan: PlannedTask[] = [
    { task: 'players' },
    { task: 'schedules', weeks: window },
    { task: 'projections', week: focus.upcoming }
  ];
  // Before the first Sunday of the season there is no finished week behind us.
  if (focus.completed) plan.push({ task: 'boxscores', week: focus.completed });
  return plan;
}

function planFor(
  params: URLSearchParams,
  focus: WeekFocus,
  week: number,
  requestedWeeks: number[] | undefined
): { plan: PlannedTask[]; mode: string } {
  const requested = (params.get('task') ?? 'weekly').toLowerCase();

  if (requested === 'weekly') return { plan: weeklyPlan(focus), mode: 'weekly' };

  if (requested === 'all') {
    return {
      plan: ALL_TASKS.map((task) =>
        task === 'schedules' ? { task, weeks: requestedWeeks } : { task, week }
      ),
      mode: 'all'
    };
  }

  const names = requested
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  for (const name of names) {
    if (!(ALL_TASKS as string[]).includes(name)) {
      throw new TypeError(
        `Unknown task "${name}". Use one of ${ALL_TASKS.join(', ')}, or "weekly" / "all".`
      );
    }
  }

  return {
    plan: names.map((name) =>
      name === 'schedules'
        ? { task: 'schedules' as TaskName, weeks: requestedWeeks }
        : { task: name as TaskName, week }
    ),
    mode: names.join(',')
  };
}

export async function handleSyncRequest(
  request: Request,
  options: SyncRequestOptions = {}
): Promise<Response> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? 55000;
  const now = options.now ?? new Date();

  const env = options.env ?? readEnv();
  const logger =
    options.logger ??
    createLogger({ level: env.logLevel, json: true, bindings: { route: '/api/sync' } });

  const auth = authorize(request, process.env.CRON_SECRET ?? '');
  if (!auth.ok) {
    logger.warn('rejected an unauthorised sync request');
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (auth.warning) logger.warn(auth.warning);

  const params = new URL(request.url).searchParams;
  const dryRun = ['1', 'true', 'yes'].includes((params.get('dry_run') ?? '').toLowerCase());

  let season: number;
  let focus: WeekFocus;
  let week: number;
  let weeks: number[] | undefined;
  let plan: PlannedTask[];
  let mode: string;

  try {
    season = params.get('season')
      ? Number.parseInt(params.get('season') as string, 10)
      : env.season;
    if (!Number.isInteger(season) || season < 1920 || season > 2100) {
      throw new TypeError(`season must be a year between 1920 and 2100, got "${params.get('season')}"`);
    }

    focus = weekFocus(now, season === currentSeason(now) ? season : undefined);
    week = parseWeek(params.get('week'), 'week') ?? env.weekOverride ?? focus.week;

    weeks = params.get('weeks')
      ? (params.get('weeks') as string)
          .split(',')
          .map((value) => parseWeek(value.trim(), 'weeks[]') as number)
      : undefined;

    ({ plan, mode } = planFor(params, focus, week, weeks));
  } catch (error) {
    logger.warn('rejected a malformed sync request', { error: (error as Error).message });
    return json({ ok: false, error: (error as Error).message }, 400);
  }

  const service =
    options.service ?? createSportsDataService({ env: { ...env, season }, logger });

  // Passed per call rather than baked into the service, so a dry run holds
  // whatever built the service.
  const taskOptions = { season, dryRun: dryRun || env.dryRun };

  logger.info('scheduled sync starting', {
    mode,
    season,
    week,
    upcoming_week: focus.upcoming,
    completed_week: focus.completed,
    provider: service.provider,
    dry_run: taskOptions.dryRun,
    tasks: plan.length
  });

  const results: SyncResult[] = [];
  const skipped: string[] = [];

  for (const step of plan) {
    if (Date.now() - startedAt > budgetMs) {
      // Out of time: say which tasks did not start rather than dying mid-flight.
      skipped.push(step.week ? `${step.task}:${step.week}` : step.task);
      continue;
    }

    /* eslint-disable no-await-in-loop */
    switch (step.task) {
      case 'players':
        results.push(await service.syncPlayersAndRosters(taskOptions));
        break;
      case 'schedules':
        results.push(await service.syncSchedules({ ...taskOptions, weeks: step.weeks }));
        break;
      case 'projections':
        results.push(await service.syncWeeklyProjections(step.week ?? week, taskOptions));
        break;
      case 'boxscores':
        results.push(await service.syncBoxScores(step.week ?? week, taskOptions));
        break;
    }
    /* eslint-enable no-await-in-loop */
  }

  const failed = results.filter((result) => !result.ok);
  const body = {
    ok: failed.length === 0 && skipped.length === 0,
    mode,
    provider: service.provider,
    season,
    week,
    focus,
    dry_run: taskOptions.dryRun,
    duration_ms: Date.now() - startedAt,
    written: results.reduce((total, result) => total + result.written, 0),
    fetched: results.reduce((total, result) => total + result.fetched, 0),
    tasks: results.map((result) => ({
      task: result.task,
      week: result.week,
      ok: result.ok,
      fetched: result.fetched,
      written: result.written,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      duration_ms: result.durationMs,
      run_id: result.runId,
      errors: result.errors
    })),
    skipped_tasks: skipped,
    warnings: auth.warning ? [auth.warning] : []
  };

  logger.info('scheduled sync finished', {
    ok: body.ok,
    written: body.written,
    failed: failed.length,
    skipped: skipped.length,
    ms: body.duration_ms
  });

  // A non-2xx marks the cron run as failed in Vercel, which is what a failed
  // sync should look like on the dashboard.
  return json(body, body.ok ? 200 : 500);
}

export default function handler(request: Request): Promise<Response> {
  return handleSyncRequest(request);
}
