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
   * The real NFL season the synced Tank01 data is read for. Both are derived
   * from today's date by js/nflData.js (the same arithmetic as
   * lib/services/env.ts) and only need setting to pin the UI to a past week —
   * `window.FSN_CONFIG = { nfl: { season: 2026, week: 1 } }`.
   */
  nfl: {
    season: runtime.nfl?.season || env.SPORTS_DATA_SEASON || null,
    week: runtime.nfl?.week || env.SPORTS_DATA_WEEK || null,
    /** Set false to skip the live reads entirely and run on the seed pool. */
    enabled: runtime.nfl?.enabled ?? true
  },

  storageKeys: {
    draft: 'fsnv2.draft.v1',
    ids: 'fsnv2.ids.v1',
    season: 'fsnv2.season.v1'
  }
};
