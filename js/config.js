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

  storageKeys: {
    draft: 'fsnv2.draft.v1',
    ids: 'fsnv2.ids.v1'
  }
};
