/**
 * api/roster/swap.js — GET the saved lineup, POST one slot swap.
 *
 * The swap is guarded: a player whose NFL game has already kicked off cannot be
 * moved, in or out, and the attempt comes back as a 400 naming them. The rule is
 * `isPlayerLocked()` in js/gameLock.js, and it is enforced twice on this path —
 * here, through `fsnv2_locked_players`, so the refusal is a clean 400 before
 * anything is attempted; and inside `fsnv2_swap_lineup` itself, which re-checks
 * the same kickoff times in the same transaction as the write so a kickoff that
 * lands mid-request cannot slip through. Both live in
 * supabase/migrations/0013_fsnv2_lineup_locks.sql.
 */

const slots = new Set(['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLEX', 'DST', 'K',
  'BN1', 'BN2', 'BN3', 'BN4', 'BN5', 'BN6']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Request key -> SQL parameter name. PostgREST matches an RPC by the exact set
 * of keys in the JSON body, so the argument names in
 * `supabase/migrations/0008_fsnv2_lineup_swaps.sql` are the contract and this
 * table is the single place the camelCase wire format is translated to it.
 * A key that is not in the signature makes the whole call 404 as PGRST202.
 */
const swapParams = {
  from: 'p_from',
  to: 'p_to',
  fromPlayerId: 'p_from_player',
  toPlayerId: 'p_to_player',
  expectedVersion: 'p_expected_version'
};

// Missing-function/-column: the catalog copy PostgREST answers from is stale.
const staleCache = new Set(['PGRST202', 'PGRST204']);

/** Postgres raises the lock refusal with this wording; so does the browser. */
const LOCK_PATTERN = /is locked because their game has already started/;

/** The sentence every layer uses, so a manager reads one wording. */
function lockedMessage(name) {
  return `Cannot move player: ${name} is locked because their game has already started.`;
}

function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.json(body);
}

function rpc(url, key, name, args) {
  return fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify(args)
  });
}

/**
 * One retry when PostgREST cannot see the function. Applying the migration
 * ends with `notify pgrst, 'reload schema'`, so the cache refreshes on its own
 * within a moment; the retry covers requests that land inside that window
 * rather than failing a swap the database is perfectly able to serve.
 */
async function callRpc(url, key, name, args) {
  let response = await rpc(url, key, name, args);
  let result = await response.json();
  if (!response.ok && staleCache.has(result?.code)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    response = await rpc(url, key, name, args);
    result = await response.json();
  }
  return { response, result };
}

/**
 * Asks the database which of these players are already playing.
 *
 * Returns null when the swap may go ahead, or `{ status, error }` when it may
 * not. A missing `fsnv2_locked_players` means migration 0013 is not on the
 * project: that is reported rather than waved through, because waving it
 * through is exactly the bug the migration exists to fix — the swap RPC behind
 * it would be unguarded too.
 *
 * @param {string} url Supabase project URL
 * @param {string} key service key
 * @param {Array<string|null>} playerIds the two sides of the swap
 */
async function lockGuard(url, key, playerIds) {
  const ids = playerIds.filter((id) => typeof id === 'string' && id !== '');
  if (ids.length === 0) return null;

  const { response, result } = await callRpc(url, key, 'fsnv2_locked_players', {
    p_player_ids: ids
  });

  if (!response.ok) {
    if (staleCache.has(result?.code)) {
      console.error('Lineup API: fsnv2_locked_players is missing — apply migration 0013.');
      return {
        status: 503,
        error:
          'Lineup locks are not set up yet. Apply supabase/migrations/0013_fsnv2_lineup_locks.sql.'
      };
    }
    return { status: 502, error: result?.message || 'Unable to check kickoff times.' };
  }

  const locked = Array.isArray(result) ? result : [];
  if (locked.length === 0) return null;
  return { status: 400, error: lockedMessage(locked[0].name || locked[0].player_id) };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Method not allowed.' });
  }
  const body = req.method === 'POST' ? req.body : req.query;
  const { draftId, teamId } = body || {};
  if (!uuid.test(draftId) || !Number.isInteger(Number(teamId)) || Number(teamId) < 1) {
    return send(res, 400, { error: 'Invalid draft or team.' });
  }
  if (req.method === 'POST' &&
      (!slots.has(body.from) || !slots.has(body.to) || body.from === body.to ||
       typeof body.fromPlayerId !== 'string' ||
       !(body.toPlayerId === null || typeof body.toPlayerId === 'string') ||
       !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0)) {
    return send(res, 400, { error: 'Invalid swap.' });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return send(res, 503, { error: 'Lineup storage is unavailable.' });
  const name = req.method === 'POST' ? 'fsnv2_swap_lineup' : 'fsnv2_lineup_state';
  const args = { p_draft_id: draftId, p_team_id: Number(teamId) };
  if (req.method === 'POST') {
    for (const [source, param] of Object.entries(swapParams)) args[param] = body[source];
  }
  try {
    if (req.method === 'POST') {
      // Both sides of the swap, before anything is written: the player coming
      // in and the one going out are equally frozen once their game is under
      // way. Checking only the incoming player is the hole that lets a manager
      // bench someone at halftime.
      const guard = await lockGuard(url, key, [body.fromPlayerId, body.toPlayerId]);
      if (guard) return send(res, guard.status, { error: guard.error });
    }

    const { response, result } = await callRpc(url, key, name, args);
    if (!response.ok) {
      // The database ran the same check inside the write and refused — a
      // kickoff that landed between the guard above and the swap itself. That
      // is the client's problem to hear about, not a server fault.
      if (LOCK_PATTERN.test(result?.message || '')) {
        return send(res, 400, { error: result.message });
      }
      // A cache miss that survives the retry means the migration is not on this
      // project; say so rather than passing PostgREST's wording to a toast.
      if (staleCache.has(result?.code)) {
        console.error('Lineup API: %s is missing — apply migration 0008.', name);
        return send(res, 503, {
          error: 'Lineup storage is not set up yet. Apply supabase/migrations/0008_fsnv2_lineup_swaps.sql.'
        });
      }
      return send(res, response.status === 400 ? 409 : 502,
        { error: result.message || 'Unable to save the lineup.' });
    }
    return send(res, 200, result);
  } catch (error) {
    console.error('Lineup API:', error);
    return send(res, 502, { error: 'Lineup storage is unavailable.' });
  }
}
