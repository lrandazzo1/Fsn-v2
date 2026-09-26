import { getCurrentNFLWeek } from './nflWeek.js';

/** Browser polling hook for the server's short-lived live box-score snapshot. */
export function useLiveMatchupStats({ season, engine, seasonYear, onUpdate, fetcher = fetch,
  intervalMs = 60_000 }) {
  let timer = null;
  let sequence = 0;

  async function refresh() {
    const seq = ++sequence;
    const week = getCurrentNFLWeek(new Date(), seasonYear);
    if (week > season.weeks) return;
    try {
      const response = await fetcher(`/api/live-matchups?week=${week}`, {
        headers: { accept: 'application/json' }, cache: 'no-store'
      });
      if (!response.ok) throw new Error(`Live matchup feed returned ${response.status}`);
      const payload = await response.json();
      if (seq !== sequence || payload.week !== week || payload.season !== seasonYear) return;
      season.setLiveMatchupStats(week, payload, engine.playersById);
      onUpdate?.(week);
    } catch (error) {
      // Leave the last good snapshot on screen; a failed request is not a zero score.
      console.warn('Live matchup refresh unavailable:', error);
    }
  }

  function start() {
    if (timer) return;
    void refresh();
    timer = setInterval(() => { if (!document.hidden) void refresh(); }, intervalMs);
    document.addEventListener('visibilitychange', onVisibility);
  }

  function onVisibility() { if (!document.hidden) void refresh(); }

  function stop() {
    clearInterval(timer);
    timer = null;
    document.removeEventListener('visibilitychange', onVisibility);
    sequence += 1;
  }

  return { start, stop, refresh };
}
