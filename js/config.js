/**
 * config.js
 * -----------------------------------------------------------------------------
 * Deployment configuration. The Supabase publishable key is safe to ship to the
 * browser — it only grants access to the `public.fsnv2_*` RPCs, and the
 * underlying `fsnv2.*` tables stay behind RLS with no direct policies.
 *
 * Override at runtime without editing this file:
 *   <script>window.FSN_CONFIG = { supabase: { url: '…', key: '…' } }</script>
 * or, for the Node test-suite, SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY.
 */

const runtime = (typeof window !== 'undefined' && window.FSN_CONFIG) || {};
const env = (typeof process !== 'undefined' && process.env) || {};

/** January and February still belong to the season that kicked off last autumn. */
function currentNflSeason(now = new Date()) {
  return now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();
}

export const CONFIG = {
  supabase: {
    url: runtime.supabase?.url || env.SUPABASE_URL || 'https://opfrwtjqjciqpmajeqlr.supabase.co',
    key:
      runtime.supabase?.key ||
      env.SUPABASE_PUBLISHABLE_KEY ||
      'sb_publishable_TvpTXNnL9VoXnYvhg7WVnw_WOrCJ2Zl',
    /** Set false to run fully offline against localStorage. */
    enabled: runtime.supabase?.enabled ?? true
  },

  league: {
    name: runtime.league?.name || 'FSN v2 Flagship League',
    totalTeams: runtime.league?.totalTeams || 12,
    rounds: runtime.league?.rounds || 15,
    scoringType: runtime.league?.scoringType || 'ppr',
    timerSeconds: runtime.league?.timerSeconds || 60,
    userTeamId: runtime.league?.userTeamId || 1
  },

  season: {
    weeks: runtime.season?.weeks || 14,
    /** Shared with `p_seed` in fsnv2_generate_schedule() — keep the two in step. */
    seed: runtime.season?.seed || 20260208
  },

  /**
   * Which slice of the synced sports data the UI reads. Mirrors the defaults in
   * lib/services/env.ts so the browser and the sync service agree without being
   * configured twice: a September-to-February date belongs to the season that
   * started in the earlier calendar year.
   */
  sportsData: {
    season: runtime.sportsData?.season || Number(env.SPORTS_DATA_SEASON) || currentNflSeason(),
    seasonType: runtime.sportsData?.seasonType || env.SPORTS_DATA_SEASON_TYPE || 'reg',
    /** Match the league's scoring so the projections on screen are the right ones. */
    scoringFormat:
      runtime.sportsData?.scoringFormat ||
      env.SPORTS_DATA_SCORING ||
      runtime.league?.scoringType ||
      'ppr',
    /** Set false to ignore the synced data and run purely on playerData.js. */
    enabled: runtime.sportsData?.enabled ?? true
  },

  storageKeys: {
    draft: 'fsnv2.draft.v1',
    ids: 'fsnv2.ids.v1',
    season: 'fsnv2.season.v1'
  }
};
