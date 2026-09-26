/** 2026 Week 1 opens Thursday, September 10. Subsequent weeks open Thursday. */
export function nflSeasonKickoff(season) {
  const september = new Date(Date.UTC(season, 8, 1));
  const firstMonday = 1 + ((8 - september.getUTCDay()) % 7);
  return new Date(Date.UTC(season, 8, firstMonday + 3));
}

/** Resolve the NFL regular-season week from the UTC calendar, clamped to 1–18. */
export function getCurrentNFLWeek(now = new Date(), season = now.getUTCMonth() >= 2
  ? now.getUTCFullYear() : now.getUTCFullYear() - 1) {
  const days = Math.floor((now.getTime() - nflSeasonKickoff(season).getTime()) / 86400000);
  return Math.max(1, Math.min(18, Math.floor(days / 7) + 1));
}
