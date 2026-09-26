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
    const { response, result } = await callRpc(url, key, name, args);
    if (!response.ok) {
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
