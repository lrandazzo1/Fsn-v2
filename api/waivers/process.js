/**
 * api/waivers/process.js — the scheduled worker that settles the waiver wire.
 *
 * Vercel Cron calls this once a week (see `crons` in vercel.json); a
 * commissioner can call it for one league with a POST. Either way the work is
 * one `fsnv2_process_waivers` call, which settles every pending bid in one
 * Postgres transaction: the auction is ordered bid_amount DESC ->
 * waiver_priority ASC -> created_at ASC, FAAB is deducted, the claimed player
 * joins the roster, the dropped player returns to free agency, and the claims
 * that depended on a drop somebody else's claim already spent are invalidated
 * with a reason. None of that is done here, and deliberately: a route that
 * settled the board over several HTTP calls could leave two teams holding the
 * same player if any one of them failed. See
 * supabase/migrations/0014_fsnv2_waivers_and_trades.sql.
 *
 * Three jobs run on this one schedule, because all three are "the league
 * caught up with the calendar" and all three want to happen before anyone
 * looks at a roster on Wednesday morning:
 *
 *   waivers   settle the pending bids
 *   trades    execute the trades that were deferred because a player was
 *             mid-game when they were agreed (status PENDING_NEXT_WEEK)
 *   expiry    withdraw the offers nobody answered in time
 *
 * `?tasks=waivers` (or a `tasks` array in the body) narrows that.
 *
 *   POST /api/waivers/process            every league, every task
 *   POST /api/waivers/process  { leagueId, now, tasks }
 *   GET  /api/waivers/process?preview=1&leagueId=…   the board, settled nothing
 *
 * Auth: `CRON_SECRET`, as a bearer token or `?secret=` — the same contract
 * /api/sync uses.
 */

import {
  authorizeCron, callRpc, credentials, instant, isUuid, methodNotAllowed, params, rpcError, send
} from '../_supabase.js';

const MIGRATION = 'supabase/migrations/0014_fsnv2_waivers_and_trades.sql';

/** task name -> the RPC that does it, in the order they have to run. */
const TASKS = [
  ['waivers', 'fsnv2_process_waivers'],
  ['trades', 'fsnv2_process_pending_trades'],
  ['expiry', 'fsnv2_expire_trades']
];

function requestedTasks(raw) {
  if (raw === undefined || raw === null || raw === '') return TASKS.map(([name]) => name);
  const asked = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((name) => String(name).trim().toLowerCase())
    .filter(Boolean);
  const known = TASKS.map(([name]) => name);
  const unknown = asked.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown task(s): ${unknown.join(', ')}. Expected ${known.join(', ')}.`);
  }
  // Order is the schedule's, not the caller's: a deferred trade is executed
  // after the wire is settled, so a player claimed this morning can be traded
  // in the same run rather than next week.
  return known.filter((name) => asked.includes(name));
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return methodNotAllowed(res, 'GET, POST');
  }

  const auth = authorizeCron(req);
  if (!auth.ok) return send(res, 401, { error: 'Unauthorized.' });

  const body = params(req);
  const leagueId = body.leagueId ?? body.league_id ?? null;
  if (leagueId !== null && !isUuid(leagueId)) {
    return send(res, 400, { error: 'Invalid league.' });
  }

  const now = instant(body.now);
  if (now === undefined) return send(res, 400, { error: 'Invalid `now` — expected an ISO instant.' });

  let tasks;
  try {
    tasks = requestedTasks(body.tasks);
  } catch (error) {
    return send(res, 400, { error: error.message });
  }

  const env = credentials();
  if (!env) return send(res, 503, { error: 'Waiver storage is unavailable.' });

  // A preview settles nothing: it is the board in the order processing will
  // walk it, which is what a league page shows before the deadline.
  if (req.method === 'GET' && (body.preview === '1' || body.preview === 'true')) {
    if (!isUuid(leagueId)) {
      return send(res, 400, { error: 'A preview needs a leagueId.' });
    }
    const { response, result } = await callRpc(env.url, env.key, 'fsnv2_waiver_board', {
      p_league_id: leagueId
    });
    if (!response.ok) {
      const mapped = rpcError(result, MIGRATION, 'Unable to read the waiver board.');
      return send(res, mapped.status, mapped.body);
    }
    return send(res, 200, { preview: true, league_id: leagueId, board: result });
  }

  const startedAt = Date.now();
  const ran = {};
  try {
    for (const [name, rpc] of TASKS) {
      if (!tasks.includes(name)) continue;

      const args = { p_league_id: leagueId, p_now: now };
      const { response, result } = await callRpc(env.url, env.key, rpc, args);
      if (!response.ok) {
        const mapped = rpcError(result, MIGRATION, `Unable to run the ${name} task.`);
        // Each task is its own transaction, so the ones that already committed
        // stand. Report what ran rather than pretending the whole run failed.
        return send(res, mapped.status, { ...mapped.body, task: name, ran });
      }
      ran[name] = result;
    }

    return send(res, 200, {
      ok: true,
      tasks,
      league_id: leagueId,
      duration_ms: Date.now() - startedAt,
      ...(auth.warning ? { warning: auth.warning } : {}),
      ...ran
    });
  } catch (error) {
    console.error('Waiver processing:', error);
    return send(res, 502, { error: 'Waiver storage is unavailable.', ran });
  }
}
