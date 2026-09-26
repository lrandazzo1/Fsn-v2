import { RAW_PLAYERS } from '../js/playerData.js';

const names = new Set(RAW_PLAYERS.map(([name]) => name));
let cached = null;
let expires = 0;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!cached || Date.now() >= expires) {
      const response = await fetch('https://api.sleeper.app/v1/players/nfl', {
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error(`Sleeper returned ${response.status}`);
      const records = await response.json();
      const selected = {};
      for (const [id, record] of Object.entries(records)) {
        if (!names.has(record.full_name)) continue;
        selected[record.full_name] = {
          player_id: id, team: record.team ?? null,
          status: record.status ?? null,
          injury_status: record.injury_status ?? null,
          news_status: record.news_status ?? null,
          search_rank: record.search_rank ?? null,
          adp_ppr: record.adp_ppr ?? null,
          adp_half_ppr: record.adp_half_ppr ?? null,
          adp_std: record.adp_std ?? null
        };
      }
      cached = selected;
      expires = Date.now() + 24 * 60 * 60 * 1000;
    }
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=3600');
    return res.status(200).json(cached);
  } catch (error) {
    // An expired snapshot is preferable to re-ranking by synthetic projections.
    if (cached) return res.status(200).json(cached);
    return res.status(503).json({ error: 'Sleeper ranks unavailable' });
  }
}
