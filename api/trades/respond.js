/**
 * api/trades/respond.js — accept, reject, withdraw or veto a trade.
 *
 *   POST /api/trades/respond
 *   { "tradeId": "…", "teamId": 2, "action": "ACCEPT", "note": "deal" }
 *
 *   ACCEPT  the recipient agrees. Nothing moves yet — /api/trades/execute does
 *           the swap. Keeping the two apart is what leaves room for a veto
 *           window, and what lets a trade whose players are mid-game wait for
 *           the week to turn instead of being thrown away.
 *   REJECT  the recipient declines.
 *   CANCEL  the proposer withdraws.
 *   VETO    the league overrules it. Not a franchise's action, so it carries no
 *           team check — which is why `fsnv2_respond_trade` is granted to
 *           service_role only and is reached through this route rather than
 *           from a browser.
 *
 * Who may do what is enforced in the database, not here: the recipient cannot
 * cancel and the proposer cannot accept their own offer. An offer whose expiry
 * has passed is cancelled on the spot rather than answered.
 */

import {
  callRpc, credentials, isTeamId, isUuid, methodNotAllowed, params, rpcError, send
} from '../_supabase.js';

const MIGRATION = 'supabase/migrations/0014_fsnv2_waivers_and_trades.sql';
const ACTIONS = new Set(['ACCEPT', 'REJECT', 'CANCEL', 'VETO']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');

  const body = params(req);
  const tradeId = body.tradeId ?? body.trade_id;
  const teamId = body.teamId ?? body.team_id;
  const action = String(body.action ?? '').trim().toUpperCase();

  if (!isUuid(tradeId)) return send(res, 400, { error: 'Invalid trade.' });
  if (!ACTIONS.has(action)) {
    return send(res, 400, { error: `Invalid action — expected ${[...ACTIONS].join(', ')}.` });
  }
  // A veto is the league's, so it needs no team. Everything else is a
  // franchise's answer and does.
  if (action !== 'VETO' && !isTeamId(teamId)) {
    return send(res, 400, { error: 'Invalid team.' });
  }

  const env = credentials();
  if (!env) return send(res, 503, { error: 'Trade storage is unavailable.' });

  try {
    const { response, result } = await callRpc(env.url, env.key, 'fsnv2_respond_trade', {
      p_trade_id: tradeId,
      p_team_id: action === 'VETO' && !isTeamId(teamId) ? null : Number(teamId),
      p_action: action,
      p_note: typeof body.note === 'string' && body.note !== '' ? body.note : null
    });

    if (!response.ok) {
      const mapped = rpcError(result, MIGRATION, 'Unable to answer the trade.');
      return send(res, mapped.status, mapped.body);
    }
    return send(res, 200, result);
  } catch (error) {
    console.error('Trade respond:', error);
    return send(res, 502, { error: 'Trade storage is unavailable.' });
  }
}
