/**
 * api/trades/execute.js — the atomic swap.
 *
 *   POST /api/trades/execute   { "tradeId": "…", "now": "2026-09-26T12:00:00Z" }
 *
 * One `fsnv2_execute_trade` call, which moves every player, every FAAB dollar
 * and nothing in between: a trade either lands whole or does not land. The
 * players are released from both rosters before either acquisition is written,
 * so a full roster is never pushed over the limit halfway through the swap.
 *
 * The guard is 0013's lineup lock, re-run over the whole trade payload. If any
 * player in the trade is in a game that has already started the trade is
 * **not** executed and **not** refused — it is marked PENDING_NEXT_WEEK with
 * `effective_week` set to the following week, and the cron worker at
 * /api/waivers/process executes it once the week turns. The response says so,
 * and names who held it up:
 *
 *   202 { "status": "PENDING_NEXT_WEEK", "locked_players": [ … ] }
 *   200 { "status": "EXECUTED", "moves": [ … ] }
 *
 * 202 rather than 200 because the swap was accepted and has not happened yet.
 *
 * The lock is checked twice on this path, the way a lineup swap is in
 * api/roster/swap.js: here, through `fsnv2_trade_lock_report`, so the deferral
 * is explainable before anything is attempted; and inside
 * `fsnv2_execute_trade` itself, which re-reads the same kickoff times in the
 * same transaction as the write — so a kickoff that lands mid-request cannot
 * slip a locked player through.
 */

import {
  callRpc, credentials, instant, isUuid, methodNotAllowed, params, rpcError, send
} from '../_supabase.js';

const MIGRATION = 'supabase/migrations/0014_fsnv2_waivers_and_trades.sql';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');

  const body = params(req);
  const tradeId = body.tradeId ?? body.trade_id;
  if (!isUuid(tradeId)) return send(res, 400, { error: 'Invalid trade.' });

  const now = instant(body.now);
  if (now === undefined) return send(res, 400, { error: 'Invalid `now` — expected an ISO instant.' });

  const env = credentials();
  if (!env) return send(res, 503, { error: 'Trade storage is unavailable.' });

  try {
    // The report first: a trade held over should be able to say why without the
    // caller having to read the status detail back out of the trade row. A
    // missing `fsnv2_trade_lock_report` is reported rather than waved through —
    // waving it through is exactly the bug the guard exists to prevent.
    const guard = await callRpc(env.url, env.key, 'fsnv2_trade_lock_report', {
      p_trade_id: tradeId,
      p_now: now
    });
    if (!guard.response.ok) {
      const mapped = rpcError(guard.result, MIGRATION, 'Unable to check kickoff times.');
      return send(res, mapped.status, mapped.body);
    }
    const locked = Array.isArray(guard.result) ? guard.result : [];

    const { response, result } = await callRpc(env.url, env.key, 'fsnv2_execute_trade', {
      p_trade_id: tradeId,
      p_now: now
    });
    if (!response.ok) {
      const mapped = rpcError(result, MIGRATION, 'Unable to execute the trade.');
      return send(res, mapped.status, mapped.body);
    }

    // The database decides which of the two happened — it re-checked the locks
    // inside the write, so its answer is the one that counts, not the report
    // above.
    const deferred = result?.status === 'PENDING_NEXT_WEEK';
    return send(res, deferred ? 202 : 200, {
      ...result,
      locked_players: result?.locked_players ?? locked
    });
  } catch (error) {
    console.error('Trade execute:', error);
    return send(res, 502, { error: 'Trade storage is unavailable.' });
  }
}
