/** Public, short-lived view of the current week's Tank01 box scores. Secrets stay server-side. */
import { currentNflWeek, currentSeason, readEnv } from '../services/env.ts';
import { createTank01Provider, livePprPoints } from '../services/providers/tank01.ts';

type LiveProvider = Pick<ReturnType<typeof createTank01Provider>, 'fetchLiveWeek'>;
const cache = new Map<string, { expires: number; body: object }>();
const pending = new Map<string, Promise<object>>();

export async function handleLiveMatchupRequest(
  request: Request,
  options: { provider?: LiveProvider; now?: Date } = {}
): Promise<Response> {
  if (request.method !== 'GET') return response({ error: 'Method not allowed' }, 405);
  const now = options.now ?? new Date();
  const env = readEnv(process.env, now);
  const url = new URL(request.url);
  const season = currentSeason(now);
  const raw = url.searchParams.get('week');
  const week = raw === null ? null : Number(raw);
  // Query parameters are deliberately narrow so a public client cannot scan seasons.
  const selected = week ?? currentNflWeek(now, season);
  if (!Number.isInteger(selected) || selected < 1 || selected > 18) {
    return response({ error: 'week must be between 1 and 18' }, 400);
  }
  if (!options.provider && (!env.apiKey || !env.apiHost)) {
    return response({ error: 'Live stats are not configured' }, 503);
  }
  const key = `${season}:${selected}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return response(hit.body, 200);

  try {
    let task = pending.get(key);
    if (!task) {
      const provider = options.provider ?? createTank01Provider({ env });
      task = provider.fetchLiveWeek({ season, week: selected, seasonType: 'reg', scoringFormat: 'ppr' },
        { includeStatuses: selected === currentNflWeek(now, season) })
        .then(({ games, stats, statuses }) => ({
          season, week: selected, updatedAt: new Date().toISOString(),
          games: games.map((game) => ({ home: game.home_team, away: game.away_team, status: game.status })),
          statuses: statuses ?? [],
          players: stats.map((row) => ({
            id: row.player_id, name: row.name, position: row.position, team: row.team,
            actualPoints: row.position === 'DST'
              ? row.fantasy_points : livePprPoints(row.stats) ?? row.fantasy_points,
            stats: row.stats
          }))
        }));
      pending.set(key, task);
    }
    const body = await task;
    cache.set(key, { body, expires: Date.now() + 60_000 });
    return response(body, 200);
  } catch (error) {
    console.error('Live matchup feed failed:', error);
    return response({ error: 'Live stats temporarily unavailable' }, 503);
  } finally {
    pending.delete(key);
  }
}

function response(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, s-maxage=60, stale-while-revalidate=30' }
  });
}
