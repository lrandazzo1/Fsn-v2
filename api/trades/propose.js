/**
 * api/trades/propose.js — POST a trade offer.
 *
 *   POST /api/trades/propose
 *   {
 *     "leagueId": "…",
 *     "proposerTeamId": 1,
 *     "recipientTeamId": 2,
 *     "items": [
 *       { "senderTeamId": 1, "assetType": "PLAYER", "assetId": "p-0007" },
 *       { "senderTeamId": 2, "assetType": "PLAYER", "assetId": "p-0031" },
 *       { "senderTeamId": 2, "assetType": "FAAB",   "amount": 15 }
 *     ],
 *     "expiresAt": "2026-09-28T17:00:00Z",   // optional, 48 hours by default
 *     "note": "need a WR2"                    // optional
 *   }
 *
 * Nothing moves. The offer is checked against both rosters first — every player
 * is owned by the team sending them, both sides can field the roster the trade
 * leaves them with, and each can cover the FAAB it is sending — so an
 * impossible trade is never on the table for the other manager to accept. That
 * check is `fsnv2.assert_trade_valid`, and it runs inside the same transaction
 * as the insert, which is why a refused proposal leaves no trade behind.
 *
 * The item shapes are normalised here, before the database sees them
 * (`normalizeTradeItems` in js/transactions.js), so a malformed asset comes
 * back as a 400 naming the item rather than as a constraint violation.
 */

import {
  callRpc, credentials, instant, isTeamId, isUuid, methodNotAllowed, params, rpcError, send
} from '../_supabase.js';
import { normalizeTradeItems } from '../../js/transactions.js';

const MIGRATION = 'supabase/migrations/0014_fsnv2_waivers_and_trades.sql';

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');

  const body = params(req);
  const leagueId = body.leagueId ?? body.league_id;
  const proposer = body.proposerTeamId ?? body.proposer_team_id;
  const recipient = body.recipientTeamId ?? body.recipient_team_id;

  if (!isUuid(leagueId) || !isTeamId(proposer) || !isTeamId(recipient)) {
    return send(res, 400, { error: 'Invalid league or teams.' });
  }
  if (Number(proposer) === Number(recipient)) {
    return send(res, 400, { error: 'A team cannot trade with itself.' });
  }

  const expiresAt = instant(body.expiresAt ?? body.expires_at);
  if (expiresAt === undefined) {
    return send(res, 400, { error: 'Invalid `expiresAt` — expected an ISO instant.' });
  }

  let items;
  try {
    items = normalizeTradeItems(body.items);
  } catch (error) {
    return send(res, 400, { error: error.message });
  }

  const senders = new Set(items.map((item) => item.sender_team_id));
  for (const sender of senders) {
    if (sender !== Number(proposer) && sender !== Number(recipient)) {
      return send(res, 400, { error: `Team ${sender} is not part of this trade.` });
    }
  }

  const env = credentials();
  if (!env) return send(res, 503, { error: 'Trade storage is unavailable.' });

  try {
    const { response, result } = await callRpc(env.url, env.key, 'fsnv2_propose_trade', {
      p_league_id: leagueId,
      p_proposer_team_id: Number(proposer),
      p_recipient_team_id: Number(recipient),
      p_items: items,
      p_expires_at: expiresAt,
      p_note: typeof body.note === 'string' && body.note !== '' ? body.note : null
    });

    if (!response.ok) {
      const mapped = rpcError(result, MIGRATION, 'Unable to propose the trade.');
      return send(res, mapped.status, mapped.body);
    }
    return send(res, 201, result);
  } catch (error) {
    console.error('Trade propose:', error);
    return send(res, 502, { error: 'Trade storage is unavailable.' });
  }
}
