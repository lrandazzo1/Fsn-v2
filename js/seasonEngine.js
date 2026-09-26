/**
 * seasonEngine.js
 * -----------------------------------------------------------------------------
 * Phase 2: the season that follows the draft.
 *
 * The draft engine ends at pick 180 with twelve filled rosters. This module
 * turns them into a 14-week season — who plays whom, what they score, and the
 * W-L / Points For / Points Against table the League Overview reads.
 *
 * Schedule shape
 * --------------
 *   Weeks 1-11   the complete round robin. With 12 teams the circle method
 *                yields exactly 11 rounds, so every franchise plays every
 *                other franchise once and nobody repeats.
 *   Weeks 12-14  a randomised rotation: three of those same eleven rounds,
 *                drawn by a seeded shuffle, with home and away flipped so the
 *                rematch is played at the other franchise.
 *
 * `lcgShuffle` and `roundRobinRounds` are mirrored verbatim in
 * supabase/migrations/0003_fsnv2_season_matchups.sql. The Park-Miller
 * multiplier is small enough that `state * 16807` stays inside the exact
 * integer range of a double, so JavaScript Numbers and Postgres bigints walk
 * the identical stream. That is what lets the browser rebuild the schedule
 * offline and still agree with the rows in the database.
 */

import { ROSTER_SLOTS } from './types.js';
import { playerKey, teamAbbr } from './liveData.js';
import { inactiveStatus } from './statsEngine.js';
import { marketRank } from './sleeperMarket.js';

/** Weeks in the fantasy regular season. */
export const SEASON_WEEKS = 14;

/** Shared with `p_seed` in fsnv2_generate_schedule() — keep the two in step. */
export const SEASON_SEED = 20260208;

/** NFL games in a season; turns a season projection into a weekly one. */
export const GAMES_PER_SEASON = 17;

/**
 * How much a position's weekly score swings around its projection. Defenses
 * are famously volatile, quarterbacks famously are not.
 */
export const VOLATILITY = { QB: 0.24, RB: 0.36, WR: 0.42, TE: 0.38, K: 0.32, DST: 0.58 };

/** Standard deviation of a head-to-head margin, used for win probability. */
const MARGIN_SIGMA = 28;

const STARTER_SLOTS = ROSTER_SLOTS.filter((slot) => slot.starter);

/* ---------------------------------------------------------------------------
 * Pure schedule math — no engine instance required, so the views, the tests
 * and the Postgres mirror can all share one implementation.
 * ------------------------------------------------------------------------- */

/**
 * Deterministic Fisher-Yates shuffle of [0 .. count-1], driven by a
 * Park-Miller minstd generator. Mirrors public.fsnv2_lcg_shuffle().
 *
 * @param {number} count
 * @param {number} seed
 * @returns {number[]}
 */
export function lcgShuffle(count, seed) {
  if (count <= 0) return [];

  let state = ((seed % 2147483647) + 2147483647) % 2147483647;
  if (state === 0) state = 1;

  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i >= 1; i -= 1) {
    state = (state * 16807) % 2147483647;
    const j = Math.floor((state / 2147483647) * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

/**
 * Circle-method round robin. The first entry stays fixed while the rest rotate
 * one position per round, which produces `n - 1` rounds in which every entry
 * meets every other exactly once. Mirrors public.fsnv2_round_robin().
 *
 * @template T
 * @param {T[]} entries even-length list of team ids (or NFL abbreviations)
 * @returns {Array<Array<[T, T]>>} rounds -> pairs
 */
export function roundRobinRounds(entries) {
  const n = entries.length;
  if (n < 2 || n % 2 !== 0) {
    throw new Error(`round robin needs an even entry count, got ${n}`);
  }

  const fixed = entries[0];
  let rotating = entries.slice(1);
  const len = rotating.length;
  const rounds = [];

  for (let round = 0; round < n - 1; round += 1) {
    const pairs = [[fixed, rotating[0]]];
    for (let i = 1; i < n / 2; i += 1) pairs.push([rotating[i], rotating[len - i]]);
    rounds.push(pairs);
    rotating = [rotating[len - 1], ...rotating.slice(0, -1)];
  }
  return rounds;
}

/**
 * The full 14-week schedule for a league.
 *
 * @param {{totalTeams?: number, weeks?: number, seed?: number}} [options]
 * @returns {Array<{week: number, teamAId: number, teamBId: number, rematch: boolean}>}
 */
export function buildSchedule({ totalTeams = 12, weeks = SEASON_WEEKS, seed = SEASON_SEED } = {}) {
  const teamIds = Array.from({ length: totalTeams }, (_, i) => i + 1);
  const rounds = roundRobinRounds(teamIds);
  const roundCount = rounds.length;          // 11 for a 12-team league
  const regular = Math.min(weeks, roundCount);
  const order = lcgShuffle(roundCount, seed);

  const schedule = [];
  for (let week = 1; week <= weeks; week += 1) {
    const rematch = week > regular;
    const roundIndex = rematch
      ? order[(week - regular - 1) % roundCount]
      : week - 1;

    rounds[roundIndex].forEach(([a, b]) => {
      schedule.push({
        week,
        // The rematch is played at the other franchise, so the sides flip.
        teamAId: rematch ? b : a,
        teamBId: rematch ? a : b,
        rematch
      });
    });
  }
  return schedule;
}

/**
 * Probability the team ahead by `margin` wins, from the logistic
 * approximation of a normal CDF (1.702 is the usual scaling constant).
 *
 * @param {number} margin projected points for minus projected points against
 * @param {number} [sigma]
 * @returns {number} 0..1
 */
export function winProbability(margin, sigma = MARGIN_SIGMA) {
  return 1 / (1 + Math.exp((-1.702 * margin) / sigma));
}

/** Bell-shaped noise in [-1, 1] — Bates(3), so blow-ups and busts stay rare. */
function noise(rng) {
  return ((rng() + rng() + rng()) / 3) * 2 - 1;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/* ---------------------------------------------------------------------------
 * SeasonEngine
 * ------------------------------------------------------------------------- */

export class SeasonEngine {
  /**
   * @param {Object} options
   * @param {import('./draftEngine.js').DraftEngine} options.engine
   * @param {number} [options.weeks]
   * @param {number} [options.seed]
   * @param {() => number} [options.random] injectable RNG so tests are stable
   */
  constructor({ engine, weeks = SEASON_WEEKS, seed = SEASON_SEED, random = Math.random,
    activeNflWeek = null } = {}) {
    this.engine = engine;
    this.weeks = weeks;
    this.seed = seed;
    this.random = random;
    this.activeNflWeek = activeNflWeek;

    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();

    /** @type {Array<{week: number, teamAId: number, teamBId: number, teamAScore: number, teamBScore: number, status: string, rematch: boolean}>} */
    this.matchups = [];

    /** `${week}:${playerId}` -> points scored that week. */
    this.scores = new Map();

    /**
     * Set by setLiveProjections() once the sync's numbers have been read.
     * @type {((player: Object, week: number) => number|null)|null}
     */
    this.liveProjections = null;
    /** Live box scores are transient and never written into simulated results. */
    this.liveMatchups = new Map();

    this.generate();
  }

  /* ------------------------------------------------------------- schedule */

  /** (Re)builds the schedule. Scores are cleared — the season starts over. */
  generate() {
    this.matchups = buildSchedule({
      totalTeams: this.engine.teamCount,
      weeks: this.weeks,
      seed: this.seed
    })
      .map((game) => ({ ...game, teamAScore: 0, teamBScore: 0, status: 'scheduled' }))
      // Same order as hydrate() and fsnv2_matchups(), so a locally generated
      // season and one read back from Postgres are indistinguishable.
      .sort((a, b) => a.week - b.week || a.teamAId - b.teamAId);
    this.scores.clear();
    this.emit('change', { reason: 'generate' });
    return this.matchups;
  }

  /** @returns {number[]} 1..weeks */
  get weekNumbers() {
    return Array.from({ length: this.weeks }, (_, i) => i + 1);
  }

  /** Games in a week, in team-a order. */
  matchupsForWeek(week) {
    return this.matchups
      .filter((game) => game.week === week)
      .sort((a, b) => a.teamAId - b.teamAId);
  }

  /** The single game a franchise plays in a week. */
  matchupForTeam(week, teamId) {
    return this.matchups.find(
      (game) => game.week === week && (game.teamAId === teamId || game.teamBId === teamId)
    );
  }

  /** The other side of a franchise's week. */
  opponentOf(week, teamId) {
    const game = this.matchupForTeam(week, teamId);
    if (!game) return null;
    return game.teamAId === teamId ? game.teamBId : game.teamAId;
  }

  /** True once every game in the week has been played. */
  isWeekPlayed(week) {
    const games = this.matchupsForWeek(week);
    return games.length > 0 && games.every((game) => game.status === 'final');
  }

  /** The first week still to be played, or the last week once the season ends. */
  get currentWeek() {
    const next = this.weekNumbers.find((week) => !this.isWeekPlayed(week));
    return next ?? this.weeks;
  }

  /* -------------------------------------------------------------- lineups */

  /**
   * A team's starting lineup, one entry per starter slot. Empty slots are kept
   * so the head-to-head table always lines up QB against QB.
   *
   * @returns {Array<{slot: typeof STARTER_SLOTS[number], player: import('./types.js').Player|null}>}
   */
  lineup(teamId) {
    const roster = this.engine.rosterFor(teamId) || {};
    return STARTER_SLOTS.map((slot) => {
      const playerId = roster[slot.key];
      return { slot, player: playerId ? this.engine.playersById[playerId] : null };
    });
  }

  /**
   * Installs the synced provider projections as the weekly points source.
   *
   * @param {((player: Object, week: number) => number|null)|null} lookup
   *   returns the real points for that player/week, or null when the provider
   *   has not published it — the season projection is then used as before.
   */
  setLiveProjections(lookup) {
    this.liveProjections = typeof lookup === 'function' ? lookup : null;
  }

  setActiveNflWeek(week) {
    this.activeNflWeek = week;
  }

  isHistoricalWeek(week) {
    return this.activeNflWeek !== null && week < this.activeNflWeek;
  }

  /**
   * A player's projected points for one week.
   *
   * Live mode uses only the provider's number for the requested week. The
   * evenly spread season estimate remains available in offline simulation.
   * Historical weeks never receive a projection.
   *
   * @param {import('./types.js').Player|null} player
   * @param {number} [week]
   */
  weeklyProjection(player, week = this.currentWeek) {
    if (!player) return 0;
    if (this.isHistoricalWeek(week)) return 0;
    if (week === this.activeNflWeek && inactiveStatus(player)) return 0;

    if (this.liveProjections) {
      const live = this.liveProjections(player, week);
      if (typeof live === 'number' && Number.isFinite(live)) return round1(live);
    }
    // A live matchup must use the week's published projection, never a
    // season-wide average masquerading as a game forecast.
    if (this.activeNflWeek !== null) return 0;
    return round1(player.projection / GAMES_PER_SEASON);
  }

  /**
   * Summed weekly projection of a team's starters, for a given week. The week
   * matters now that the provider publishes a different number per week; it
   * defaults to the week the season is on for the older callers.
   */
  projectedTotal(teamId, week = this.currentWeek) {
    return round1(
      this.lineup(teamId).reduce((sum, entry) => sum + this.weeklyProjection(entry.player, week), 0)
    );
  }

  /** What a player actually scored in a week, or null if it has not been played. */
  scoreFor(week, playerId) {
    if (this.isHistoricalWeek(week)) {
      const snapshot = this.liveMatchups.get(week);
      if (!this.hasCompletedBoxScores(week)) return null;
      return snapshot.scores.get(playerId) ?? 0;
    }
    const value = this.scores.get(`${week}:${playerId}`);
    return value === undefined ? null : value;
  }

  /** Apply one authoritative snapshot, matching provider ids first and unique names second. */
  setLiveMatchupStats(week, payload, playersById) {
    const candidates = new Map();
    for (const player of Object.values(playersById)) {
      const key = player.position === 'DST' ? `DST|${teamAbbr(player.team)}` : playerKey(player.name);
      const list = candidates.get(key) || [];
      list.push(player);
      candidates.set(key, list);
    }
    if (week === this.activeNflWeek) {
      for (const row of payload.statuses || []) {
        const hits = candidates.get(playerKey(row.name)) || [];
        const player = playersById[row.id] || (hits.length === 1 ? hits[0] : null);
        if (!player) continue;
        // A fresh active status must also clear a stale injury designation.
        player.status = row.status;
        player.injuryStatus = row.injury_status;
        player.newsStatus = row.news_status;
        player.injury = { designation: row.injury_status, news_status: row.news_status };
        player.adp = marketRank(player);
      }
    }
    const games = new Map();
    for (const game of payload.games || []) {
      if (!['in_progress', 'final'].includes(game.status)) continue;
      games.set(teamAbbr(game.home), game.status);
      games.set(teamAbbr(game.away), game.status);
    }
    const scores = new Map();
    const playerStatuses = new Map();
    for (const row of payload.players || []) {
      const key = row.position === 'DST' || String(row.id || '').includes('DST-')
        ? `DST|${teamAbbr(row.team)}` : playerKey(row.name);
      const hits = candidates.get(key) || [];
      const player = playersById[row.id] || (hits.length === 1 ? hits[0] : null);
      if (!player || !games.has(teamAbbr(row.team)) || !Number.isFinite(row.actualPoints)) continue;
      scores.set(player.id, row.actualPoints);
      playerStatuses.set(player.id, games.get(teamAbbr(row.team)));
    }
    this.liveMatchups.set(week, { games, scores, playerStatuses,
      receivedStats: Boolean(payload.players?.length),
      complete: Boolean(payload.games?.length) && payload.games.every((game) => game.status === 'final') });
    if (this.isHistoricalWeek(week) && this.hasCompletedBoxScores(week)) {
      for (const game of this.matchupsForWeek(week)) {
        game.teamAScore = this.actualTotal(week, game.teamAId);
        game.teamBScore = this.actualTotal(week, game.teamBId);
        game.status = 'final';
      }
    }
    if (week === this.activeNflWeek) {
      for (const player of Object.values(playersById)) {
        player.actualPoints = this.livePointFor(week, player);
        player.projectedPoints = this.weeklyProjection(player, week);
        player.liveStatus = this.liveStatusFor(week, player);
      }
    }
    this.emit('change', { reason: 'live_stats', week });
  }

  liveStatusFor(week, player) {
    if (!player) return null;
    const snapshot = this.liveMatchups.get(week);
    return snapshot?.playerStatuses.get(player.id) ?? snapshot?.games.get(teamAbbr(player.team)) ?? null;
  }

  livePointFor(week, player) {
    if (!player || !this.hasLiveScores(week) || !this.liveStatusFor(week, player)) return null;
    return this.liveMatchups.get(week).scores.get(player.id) ?? 0;
  }

  hasLiveScores(week) {
    const snapshot = this.liveMatchups.get(week);
    return Boolean(snapshot?.games.size && snapshot.receivedStats);
  }

  hasCompletedBoxScores(week) {
    return this.hasLiveScores(week) && this.liveMatchups.get(week).complete;
  }

  actualTotal(week, teamId) {
    return round2(this.lineup(teamId).reduce((total, { player }) =>
      total + (this.livePointFor(week, player) ?? 0), 0));
  }

  /**
   * The number to put on the scoreboard: the real total once the week is
   * final, the projection until then.
   */
  displayTotal(week, teamId) {
    if (this.isHistoricalWeek(week)) return this.hasCompletedBoxScores(week)
      ? this.actualTotal(week, teamId) : 0;
    if (this.hasLiveScores(week)) return this.actualTotal(week, teamId);
    const game = this.matchupForTeam(week, teamId);
    if (game && game.status === 'final') {
      return game.teamAId === teamId ? game.teamAScore : game.teamBScore;
    }
    return this.projectedTotal(teamId, week);
  }

  /**
   * Win probability for the A side of a game. A finished week is not a
   * forecast any more, so it collapses to 1 / 0 / 0.5.
   */
  winProbabilityFor(game) {
    if (!game) return 0.5;
    if (this.isHistoricalWeek(game.week)) {
      if (!this.hasCompletedBoxScores(game.week)) return 0.5;
      const a = this.actualTotal(game.week, game.teamAId);
      const b = this.actualTotal(game.week, game.teamBId);
      return a === b ? 0.5 : a > b ? 1 : 0;
    }
    if (game.status === 'final' && !this.hasLiveScores(game.week)) {
      if (game.teamAScore === game.teamBScore) return 0.5;
      return game.teamAScore > game.teamBScore ? 1 : 0;
    }
    return winProbability(
      this.projectedTotal(game.teamAId, game.week) - this.projectedTotal(game.teamBId, game.week)
    );
  }

  /* ----------------------------------------------------------- simulation */

  /**
   * Rolls one week: every rostered player gets a score built from their weekly
   * projection plus position-weighted noise, starters are summed into the
   * matchup totals, and the week is marked final.
   *
   * @param {number} week
   * @param {{random?: () => number}} [options]
   * @returns {{week: number, scores: Array<Object>, matchups: Array<Object>}}
   */
  simulateWeek(week, { random = this.random } = {}) {
    const games = this.matchupsForWeek(week);
    if (games.length === 0) throw new Error(`Week ${week} is not on the schedule.`);

    const rows = [];

    this.engine.teams.forEach((team) => {
      const roster = this.engine.rosterFor(team.id) || {};
      Object.entries(roster).forEach(([slotKey, playerId]) => {
        if (!playerId) return;
        const player = this.engine.playersById[playerId];
        if (!player) return;

        const slot = ROSTER_SLOTS.find((entry) => entry.key === slotKey);
        const projected = this.weeklyProjection(player, week);
        const swing = VOLATILITY[player.position] ?? 0.35;
        const points = Math.max(0, round1(projected * (1 + swing * noise(random))));

        this.scores.set(`${week}:${playerId}`, points);
        rows.push({
          team_id: team.id,
          player_id: playerId,
          slot: slotKey,
          starter: Boolean(slot?.starter),
          projected,
          points
        });
      });
    });

    // Starters only — the bench scores are recorded but never counted.
    const startersTotal = (teamId) =>
      round2(
        rows
          .filter((row) => row.team_id === teamId && row.starter)
          .reduce((sum, row) => sum + row.points, 0)
      );

    games.forEach((game) => {
      game.teamAScore = startersTotal(game.teamAId);
      game.teamBScore = startersTotal(game.teamBId);
      game.status = 'final';
    });

    this.emit('change', { reason: 'simulate', week });
    return { week, scores: rows, matchups: games };
  }

  /** Simulates every unplayed week up to and including `week`. */
  simulateThrough(week, options = {}) {
    const played = [];
    for (let w = 1; w <= week; w += 1) {
      if (!this.isWeekPlayed(w)) played.push(this.simulateWeek(w, options));
    }
    return played;
  }

  /** Clears results for one week, or the whole season when `week` is omitted. */
  resetSeason(week = null) {
    this.matchups.forEach((game) => {
      if (week !== null && game.week !== week) return;
      game.teamAScore = 0;
      game.teamBScore = 0;
      game.status = 'scheduled';
    });

    if (week === null) this.scores.clear();
    else {
      [...this.scores.keys()].forEach((key) => {
        if (key.startsWith(`${week}:`)) this.scores.delete(key);
      });
    }

    this.emit('change', { reason: 'reset', week });
  }

  /* ------------------------------------------------------------ standings */

  /**
   * W-L-T, Points For and Points Against. Only games marked final count, so an
   * unplayed week never moves a record. Mirrors fsnv2_season_standings().
   *
   * @returns {Array<{team, teamId, rank, games, wins, losses, ties, pointsFor, pointsAgainst, diff, pct, streak}>}
   */
  standings() {
    const rows = new Map(
      this.engine.teams.map((team) => [
        team.id,
        {
          team,
          teamId: team.id,
          games: 0,
          wins: 0,
          losses: 0,
          ties: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          results: /** @type {string[]} */ ([])
        }
      ])
    );

    [...this.matchups]
      .filter((game) => game.status === 'final')
      .sort((a, b) => a.week - b.week)
      .forEach((game) => {
        const sides = [
          [game.teamAId, game.teamAScore, game.teamBScore],
          [game.teamBId, game.teamBScore, game.teamAScore]
        ];
        sides.forEach(([teamId, pf, pa]) => {
          const row = rows.get(teamId);
          if (!row) return;
          row.games += 1;
          row.pointsFor = round2(row.pointsFor + pf);
          row.pointsAgainst = round2(row.pointsAgainst + pa);
          if (pf > pa) {
            row.wins += 1;
            row.results.push('W');
          } else if (pf < pa) {
            row.losses += 1;
            row.results.push('L');
          } else {
            row.ties += 1;
            row.results.push('T');
          }
        });
      });

    return [...rows.values()]
      .map((row) => ({
        ...row,
        diff: round2(row.pointsFor - row.pointsAgainst),
        pct: row.games === 0 ? 0 : (row.wins + row.ties * 0.5) / row.games,
        streak: currentStreak(row.results)
      }))
      .sort(
        (a, b) =>
          b.pct - a.pct ||
          b.wins - a.wins ||
          b.pointsFor - a.pointsFor ||
          a.teamId - b.teamId
      )
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  /** The standings row for one franchise. */
  recordFor(teamId) {
    return this.standings().find((row) => row.teamId === teamId);
  }

  /** "6-2" / "6-2-1" */
  recordLabel(teamId) {
    const row = this.recordFor(teamId);
    if (!row) return '0-0';
    return row.ties ? `${row.wins}-${row.losses}-${row.ties}` : `${row.wins}-${row.losses}`;
  }

  /* ---------------------------------------------------------- persistence */

  /**
   * Replays rows read back from Postgres (or the localStorage mirror). The
   * schedule is rebuilt from the rows themselves, so the database stays the
   * source of truth for who plays whom.
   *
   * @param {{matchups?: Array<Object>, scores?: Array<Object>}} state
   */
  hydrate({ matchups = [], scores = [] } = {}) {
    if (matchups.length) {
      this.matchups = matchups
        .map((row) => ({
          week: Number(row.week),
          teamAId: Number(row.team_a_id ?? row.teamAId),
          teamBId: Number(row.team_b_id ?? row.teamBId),
          teamAScore: Number(row.team_a_score ?? row.teamAScore ?? 0),
          teamBScore: Number(row.team_b_score ?? row.teamBScore ?? 0),
          status: row.status || 'scheduled',
          rematch: Boolean(row.rematch)
        }))
        .sort((a, b) => a.week - b.week || a.teamAId - b.teamAId);

      this.weeks = this.matchups.reduce((max, game) => Math.max(max, game.week), 0) || this.weeks;
    }

    this.scores.clear();
    scores.forEach((row) => {
      const playerId = row.player_id ?? row.playerId;
      if (!playerId) return;
      this.scores.set(`${row.week}:${playerId}`, Number(row.points));
    });

    this.emit('change', { reason: 'hydrate', weeks: this.weeks });
    return this.matchups.length;
  }

  /** Serialisable snapshot for the localStorage mirror. */
  toJSON() {
    return {
      weeks: this.weeks,
      seed: this.seed,
      matchups: this.matchups.map((game) => ({
        week: game.week,
        team_a_id: game.teamAId,
        team_b_id: game.teamBId,
        team_a_score: game.teamAScore,
        team_b_score: game.teamBScore,
        status: game.status,
        rematch: game.rematch
      })),
      scores: [...this.scores.entries()].map(([key, points]) => {
        const [week, playerId] = splitScoreKey(key);
        return { week, player_id: playerId, points };
      })
    };
  }

  /* ---------------------------------------------------------------- events */

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const handlers = this.listeners.get(event) || [];
    this.listeners.set(event, handlers.filter((fn) => fn !== handler));
  }

  emit(event, payload) {
    (this.listeners.get(event) || []).forEach((handler) => handler(payload, this));
  }
}

/** "W W L W" -> "W3" (the run at the end of the list). */
function currentStreak(results) {
  if (results.length === 0) return '—';
  const last = results[results.length - 1];
  let count = 0;
  for (let i = results.length - 1; i >= 0 && results[i] === last; i -= 1) count += 1;
  return `${last}${count}`;
}

/** Player ids contain no colon, so the first one always ends the week. */
function splitScoreKey(key) {
  const index = key.indexOf(':');
  return [Number(key.slice(0, index)), key.slice(index + 1)];
}
