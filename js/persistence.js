/**
 * persistence.js
 * -----------------------------------------------------------------------------
 * Draft persistence: every selection is written to Postgres through the
 * `public.fsnv2_record_pick` RPC, which re-derives the snake order server-side
 * and rejects anything out of sequence.
 *
 * It is also the read side of the sports-data sync: `liveBundle()` pulls the
 * synced player pool, the week's provider projections and the real NFL slate
 * through the four read RPCs, which are granted to `anon` so the publishable
 * key is enough.
 *
 * Design notes
 *  - Plain `fetch` against PostgREST rather than the supabase-js bundle, so the
 *    exact same module runs in the browser and in the Node test-suite.
 *  - Writes are queued and retried; the UI never blocks on the network.
 *  - A localStorage mirror is always kept, so a refresh restores the room even
 *    when Supabase is unreachable or disabled.
 *  - Reads resolve to null instead of throwing, so every caller has a working
 *    offline path.
 */

import { CONFIG } from './config.js';
import { valueDelta } from './vorMath.js';

const hasLocalStorage = (() => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
})();

export class DraftRepository {
  /**
   * @param {Object} [options]
   * @param {string} [options.url]
   * @param {string} [options.key]
   * @param {boolean} [options.enabled]
   * @param {Function} [options.onStatus] (status) => void
   */
  constructor({ url, key, enabled, onStatus } = {}) {
    this.url = url || CONFIG.supabase.url;
    this.key = key || CONFIG.supabase.key;
    this.enabled = (enabled ?? CONFIG.supabase.enabled) && Boolean(this.url && this.key);
    this.onStatus = onStatus || (() => {});

    this.leagueId = null;
    this.draftId = null;

    /** @type {Array<{name: string, args: Object, resolve: Function, reject: Function}>} */
    this.queue = [];
    this.flushing = false;
    this.status = this.enabled ? 'idle' : 'offline';
    this.lastError = null;
  }

  setStatus(status, error = null) {
    this.status = status;
    this.lastError = error;
    this.onStatus({ status, error, pending: this.queue.length });
  }

  /** Raw PostgREST RPC call. */
  async rpc(name, args = {}) {
    if (!this.enabled) throw new Error('Supabase persistence is disabled.');
    const response = await fetch(`${this.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: this.key,
        Authorization: `Bearer ${this.key}`
      },
      body: JSON.stringify(args)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${name} failed (${response.status}): ${detail}`);
    }
    return response.json();
  }

  /* ----------------------------------------------------------- bootstrapping */

  /**
   * Reuses the league/draft ids saved locally, or provisions a fresh pair.
   * @param {Object} league
   * @param {Array<{slot: number, name: string, abbr: string, is_user: boolean}>} teams
   */
  async ensureDraft(league, teams) {
    const saved = this.readIds();
    if (saved?.draftId && saved?.leagueId) {
      this.leagueId = saved.leagueId;
      this.draftId = saved.draftId;
      try {
        const state = await this.draftState();
        if (state?.draft) {
          this.setStatus('idle');
          return { leagueId: this.leagueId, draftId: this.draftId, state, created: false };
        }
      } catch (error) {
        this.setStatus('error', error.message); // fall through and re-provision
      }
    }

    const leagueRow = await this.rpc('fsnv2_create_league', {
      p_name: league.name,
      p_total_teams: league.totalTeams,
      p_scoring_type: league.scoringType
    });
    this.leagueId = leagueRow.id;

    const draftRow = await this.rpc('fsnv2_start_draft', {
      p_league_id: this.leagueId,
      p_rounds: league.rounds,
      p_timer_seconds: league.timerSeconds,
      p_teams: teams
    });
    this.draftId = draftRow.id;

    this.writeIds({ leagueId: this.leagueId, draftId: this.draftId });
    this.setStatus('idle');
    return { leagueId: this.leagueId, draftId: this.draftId, state: null, created: true };
  }

  /**
   * Pushes the local projection pool into `fsnv2.players` in batches.
   *
   * The `team` on these rows is only ever a starting point: since migration
   * 0006, fsnv2_upsert_players() prefers the team the sports-data sync
   * established over the one sent from here, so a stale static row can no
   * longer move a player back off his real roster. adp and `stats` are the
   * browser's own numbers and are written as sent.
   */
  async syncPlayers(players, batchSize = 120) {
    const rows = players.map((player) => ({
      id: player.id,
      name: player.name,
      position: player.position,
      team: player.team,
      adp: player.adp,
      stats: {
        projection: player.projection,
        vor: player.vor,
        tier: player.tier,
        pos_rank: player.posRank,
        vor_rank: player.vorRank,
        sleeper_id: player.sleeperId,
        sleeper_adp: player.sleeperAdp,
        search_rank: player.searchRank,
        value_delta: valueDelta(player)
      }
    }));

    let written = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      // eslint-disable-next-line no-await-in-loop
      written += await this.rpc('fsnv2_upsert_players', { p_players: rows.slice(i, i + batchSize) });
    }
    return written;
  }

  /* ------------------------------------------------------------------ writes */

  /**
   * Persists one selection. Queued so a slow network never stalls the clock.
   * @param {import('./types.js').Pick} pick
   */
  recordPick(pick) {
    return this.enqueue('fsnv2_record_pick', {
      p_draft_id: this.draftId,
      p_pick_number: pick.overall,
      p_player_id: pick.playerId,
      p_team_id: pick.teamId,
      p_auto: Boolean(pick.auto),
      p_source: pick.source || (pick.auto ? 'bot' : 'manual')
    });
  }

  undoPick() {
    return this.enqueue('fsnv2_undo_pick', { p_draft_id: this.draftId });
  }

  resetDraft() {
    return this.enqueue('fsnv2_reset_draft', { p_draft_id: this.draftId });
  }

  /* ------------------------------------------------------------------- reads */

  draftState(draftId = this.draftId) {
    return this.rpc('fsnv2_draft_state', { p_draft_id: draftId });
  }

  leagues() {
    return this.rpc('fsnv2_leagues', {});
  }

  players(limit = 1000) {
    return this.rpc('fsnv2_players', { p_limit: limit });
  }

  /**
   * One week of provider projections. `scoringFormat` null returns every
   * format the sync has stored; pass the league's to keep the numbers honest.
   */
  projections({ season, week, scoringFormat = null, seasonType = 'reg', limit = 1000 } = {}) {
    return this.rpc('fsnv2_projections', {
      p_season: season,
      p_week: week,
      p_scoring_format: scoringFormat,
      p_season_type: seasonType,
      p_limit: limit
    });
  }

  /** The real NFL slate. `week` null returns every synced week. */
  nflSchedule({ season, week = null, seasonType = 'reg' } = {}) {
    return this.rpc('fsnv2_nfl_schedule', {
      p_season: season,
      p_week: week,
      p_season_type: seasonType
    });
  }

  nflTeams() {
    return this.rpc('fsnv2_nfl_teams', {});
  }

  /**
   * Everything the UI needs from the sync, in one shot.
   *
   * All four RPCs are granted to `anon`, so the publishable key in config.js is
   * enough — no service key ever reaches the browser. Resolves to null rather
   * than throwing when Supabase is off or unreachable: the caller falls back to
   * the static pool in playerData.js and the app carries on offline.
   *
   * Projections are fetched per week because the RPC takes one week at a time;
   * the weeks actually synced are discovered from the schedule, so a season
   * with only week 3 in the database costs exactly one projections call.
   *
   * @param {{season: number, weeks?: number[], scoringFormat?: string|null, limit?: number}} options
   * @returns {Promise<{players: Array, projections: Array, schedule: Array}|null>}
   */
  async liveBundle({ season, weeks = null, scoringFormat = null, limit = 1000 } = {}) {
    if (!this.enabled) return null;

    try {
      const [players, schedule] = await Promise.all([
        this.players(limit),
        this.nflSchedule({ season })
      ]);

      const scheduleRows = Array.isArray(schedule) ? schedule : [];
      const syncedWeeks = weeks
        ? weeks
        : [...new Set(scheduleRows.map((game) => Number(game.week)).filter(Number.isFinite))];

      const projectionPages = await Promise.all(
        syncedWeeks.map((week) =>
          this.projections({ season, week, scoringFormat, limit }).catch(() => [])
        )
      );

      return {
        players: Array.isArray(players) ? players : [],
        schedule: scheduleRows,
        projections: projectionPages.flatMap((page) => (Array.isArray(page) ? page : []))
      };
    } catch (error) {
      this.setStatus('error', error.message);
      return null;
    }
  }

  /* ------------------------------------------------------------------- queue */

  enqueue(name, args) {
    if (!this.enabled || !this.draftId) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.queue.push({ name, args, resolve, reject, attempts: 0 });
      this.setStatus('syncing');
      this.flush();
    });
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;

    while (this.queue.length > 0) {
      const job = this.queue[0];
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.rpc(job.name, job.args);
        this.queue.shift();
        job.resolve(result);
      } catch (error) {
        job.attempts += 1;
        if (job.attempts >= 3) {
          this.queue.shift();
          this.setStatus('error', error.message);
          job.reject(error);
        } else {
          // eslint-disable-next-line no-await-in-loop
          await sleep(300 * job.attempts);
        }
      }
    }

    this.flushing = false;
    this.setStatus(this.lastError ? 'error' : 'synced', this.lastError);
  }

  /** Resolves once every queued write has landed — used by the test-suite. */
  async drain() {
    while (this.queue.length > 0 || this.flushing) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(40);
    }
    return true;
  }

  /* ------------------------------------------------------- local mirror ----- */

  saveLocal(snapshot) {
    if (!hasLocalStorage) return;
    try {
      localStorage.setItem(
        CONFIG.storageKeys.draft,
        JSON.stringify({ ...snapshot, savedAt: new Date().toISOString() })
      );
    } catch {
      /* quota or private mode — the DB is the source of truth anyway */
    }
  }

  loadLocal() {
    if (!hasLocalStorage) return null;
    try {
      const raw = localStorage.getItem(CONFIG.storageKeys.draft);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  clearLocal() {
    if (!hasLocalStorage) return;
    try {
      localStorage.removeItem(CONFIG.storageKeys.draft);
    } catch {
      /* ignore */
    }
  }

  readIds() {
    if (!hasLocalStorage) return this.leagueId ? { leagueId: this.leagueId, draftId: this.draftId } : null;
    try {
      const raw = localStorage.getItem(CONFIG.storageKeys.ids);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  writeIds(ids) {
    if (!hasLocalStorage) return;
    try {
      localStorage.setItem(CONFIG.storageKeys.ids, JSON.stringify(ids));
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * SeasonRepository
 * -----------------------------------------------------------------------------
 * Phase 2 persistence: the 14-week schedule, simulated weeks and the W-L table.
 *
 * It borrows the draft repository's transport rather than opening its own — the
 * league id, the PostgREST plumbing and the sync-status pill are all already
 * there, and a season only ever exists alongside the draft that produced it.
 * Reads and writes go straight out (no retry queue): unlike a pick, a simulated
 * week is a deliberate action the operator can simply run again.
 */
export class SeasonRepository {
  /** @param {DraftRepository} draftRepo */
  constructor(draftRepo) {
    this.repo = draftRepo;
  }

  get enabled() {
    return this.repo.enabled;
  }

  get leagueId() {
    return this.repo.leagueId;
  }

  /** Creates the schedule if the league has none; returns the matchup rows. */
  generateSchedule({ weeks = 14, seed, replace = false } = {}) {
    return this.rpc('fsnv2_generate_schedule', {
      p_league_id: this.leagueId,
      p_weeks: weeks,
      ...(seed === undefined ? {} : { p_seed: seed }),
      p_replace: replace
    });
  }

  /** Schedule, standings and every recorded box-score row in one round trip. */
  seasonState() {
    return this.rpc('fsnv2_season_state', { p_league_id: this.leagueId });
  }

  matchups(week = null) {
    return this.rpc('fsnv2_matchups', { p_league_id: this.leagueId, p_week: week });
  }

  /**
   * Writes one simulated week. The RPC re-sums the team totals from these rows,
   * so the matchup scores can never drift from the box score underneath them.
   * @param {number} week
   * @param {Array<Object>} scores rows from SeasonEngine.simulateWeek()
   */
  simulateWeek(week, scores) {
    return this.rpc('fsnv2_simulate_week', {
      p_league_id: this.leagueId,
      p_week: week,
      p_scores: scores
    });
  }

  seasonStandings() {
    return this.rpc('fsnv2_season_standings', { p_league_id: this.leagueId });
  }

  /** Rolls one week — or the whole season — back to unplayed. */
  resetSeason(week = null) {
    return this.rpc('fsnv2_reset_season', { p_league_id: this.leagueId, p_week: week });
  }

  /** Resolves to null instead of throwing when Supabase is off or unprovisioned. */
  rpc(name, args) {
    if (!this.enabled || !this.leagueId) return Promise.resolve(null);
    return this.repo.rpc(name, args);
  }

  /* ------------------------------------------------------- local mirror ---- */

  saveLocal(snapshot) {
    if (!hasLocalStorage) return;
    try {
      localStorage.setItem(
        CONFIG.storageKeys.season,
        JSON.stringify({ ...snapshot, savedAt: new Date().toISOString() })
      );
    } catch {
      /* quota or private mode — the DB is the source of truth anyway */
    }
  }

  loadLocal() {
    if (!hasLocalStorage) return null;
    try {
      const raw = localStorage.getItem(CONFIG.storageKeys.season);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  clearLocal() {
    if (!hasLocalStorage) return;
    try {
      localStorage.removeItem(CONFIG.storageKeys.season);
    } catch {
      /* ignore */
    }
  }
}
