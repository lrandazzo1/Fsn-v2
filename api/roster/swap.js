const slots = new Set(['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLEX', 'DST', 'K',
  'BN1', 'BN2', 'BN3', 'BN4', 'BN5', 'BN6']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.json(body);
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
  if (req.method === 'POST') Object.assign(args, {
    p_from: body.from, p_to: body.to,
    p_from_player: body.fromPlayerId, p_to_player: body.toPlayerId,
    p_expected_version: body.expectedVersion
  });
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify(args)
    });
    const result = await response.json();
    if (!response.ok) return send(res, response.status === 400 ? 409 : 502,
      { error: result.message || 'Unable to save the lineup.' });
    return send(res, 200, result);
  } catch (error) {
    console.error('Lineup API:', error);
    return send(res, 502, { error: 'Lineup storage is unavailable.' });
  }
}
