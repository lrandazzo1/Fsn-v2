/**
 * draftEngine.js
 * -----------------------------------------------------------------------------
 * Authoritative state manager for a snake draft (12 teams x 15 rounds by
 * default).
 *
 * Snake rotation
 * --------------
 *   Round 1 (odd)  -> teams 1, 2, 3 ... 12
 *   Round 2 (even) -> teams 12, 11, 10 ... 1
 *   Round 3 (odd)  -> teams 1, 2, 3 ... 12
 *
 * `teamIdForPick()` is the single source of truth for that mapping; the board,
 * the "on the clock" indicator, the next-up previews and the Postgres function
 * `public.fsnv2_snake_team()` all derive from the same formula, so the client
 * and the database can never disagree about whose pick it is.
 *
 * The engine owns every mutation (pick, auto-pick, clock expiry, undo, reset)
 * and emits events afterwards, which keeps rendering a pure function of state.
 */

import {
  DEFAULT_TEAM_NAMES,
  POSITIONS,
  POSITION_LIMITS,
  ROSTER_SLOTS,
  STARTER_REQUIREMENTS,
  createPick,
  createRosterSlots,
  createTeam
} from './types.js';
import { draftValue, enrichPlayers, recommendPlayers } from './vorMath.js';
import { loadPlayers } from './playerData.js';
import { applyPlayerAssets, emptyPlayerAssets } from './playerAssets.js';
import { PickTimer } from './draftTimer.js';

/* ---------------------------------------------------------------------------
 * Pure snake helpers — no engine instance required, so the renderer, the bots,
 * the tests and any future server code can all share one implementation.
 * ------------------------------------------------------------------------- */

/**
 * Maps a 1-based overall pick to a 0-based team index.
 *
 *   round       = Math.ceil(overallPick / totalTeams)
 *   pickInRound = (overallPick - 1) % totalTeams + 1
 *   odd round   -> pickInRound - 1                 (1 -> N)
 *   even round  -> totalTeams - pickInRound        (N -> 1)
 *
 * @param {number} overallPick 1-based
 * @param {number} totalTeams
 * @param {'snake'|'linear'} [draftType]
 * @returns {number} 0-based team index
 */
export function snakeTeamIndex(overallPick, totalTeams, draftType = 'snake') {
  const round = Math.ceil(overallPick / totalTeams);
  const pickInRound = ((overallPick - 1) % totalTeams) + 1;
  if (draftType === 'linear') return pickInRound - 1;
  return round % 2 === 1 ? pickInRound - 1 : totalTeams - pickInRound;
}

/** Same mapping, 1-based team id. Mirrors public.fsnv2_snake_team() in Postgres. */
export function snakeTeamId(overallPick, totalTeams, draftType = 'snake') {
  return snakeTeamIndex(overallPick, totalTeams, draftType) + 1;
}

/**
 * Inverse mapping: which overall pick does a team own in a given round?
 * Round 2 gives team 12 pick 13 and team 1 pick 24.
 *
 * @param {number} round 1-based
 * @param {number} teamId 1-based
 * @param {number} totalTeams
 * @param {'snake'|'linear'} [draftType]
 * @returns {number} 1-based overall pick
 */
export function snakePickNumber(round, teamId, totalTeams, draftType = 'snake') {
  const pickInRound = draftType === 'linear' || round % 2 === 1 ? teamId : totalTeams - teamId + 1;
  return (round - 1) * totalTeams + pickInRound;
}

const DEFAULTS = {
  teamCount: 12,
  rounds: 15,
  userTeamId: 1,
  /** 'snake' reverses every even round; 'linear' keeps 1 -> N every round. */
  draftType: 'snake',
  /** Pick clock length in seconds. */
  timerSeconds: 60,
  /** Start the clock automatically as soon as the draft begins. */
  autoStartClock: false,
  /** Higher = more chaotic bots. 0 = always takes the top board value. */
  botRandomness: 0.18,
  /** Injected into PickTimer so tests can drive the clock synchronously. */
  scheduler: undefined
};

export class DraftEngine {
  /**
   * @param {Partial<typeof DEFAULTS> & {players?: import('./types.js').Player[]}} [options]
   */
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();

    /**
     * Headshots and external ids, keyed for lookup. Held on the engine rather
     * than in a view because `reset()` rebuilds the pool from playerData.js —
     * whatever the database told us has to survive that.
     */
    this.playerAssets = emptyPlayerAssets();

    this.clock = new PickTimer({
      seconds: this.config.timerSeconds,
      scheduler: this.config.scheduler,
      onTick: (remaining) => this.emit('tick', { remaining, timer: this.clock }),
      onExpire: () => this.handleClockExpiry()
    });

    this.reset({ silent: true });
    this.emit('change', { reason: 'init' });
  }

  // ---------------------------------------------------------------- lifecycle

  /** Rebuilds a fresh draft with the current configuration. */
  reset({ silent = false } = {}) {
    const { teamCount, rounds, userTeamId, players } = this.config;

    this.clock.stop();

    const pool = enrichPlayers(players ? clonePlayers(players) : loadPlayers(), teamCount);

    /** @type {Record<string, import('./types.js').Player>} */
    this.playersById = {};
    pool.forEach((player) => {
      this.playersById[player.id] = player;
    });
    applyPlayerAssets(this.playersById, this.playerAssets);

    this.teams = Array.from({ length: teamCount }, (_, index) => {
      const id = index + 1;
      return createTeam(id, DEFAULT_TEAM_NAMES[index] || `Team ${id}`, id === userTeamId);
    });

    /** @type {Record<number, Record<string, string|null>>} */
    this.rosters = {};
    this.teams.forEach((team) => {
      this.rosters[team.id] = createRosterSlots();
    });

    /** @type {import('./types.js').Pick[]} */
    this.picks = [];
    this.currentPick = 1;
    this.totalPicks = teamCount * rounds;
    this.complete = false;
    this.autoDraftUser = false;

    if (!silent) this.emit('change', { reason: 'reset' });
    if (this.config.autoStartClock && !silent) this.startClock();
  }

  /**
   * Merges the database's player imagery into the pool and keeps the index so
   * `reset()` can re-apply it. Emits `change` so every open view repaints with
   * the headshots the moment the read lands.
   *
   * @param {ReturnType<import('./playerAssets.js').indexPlayerAssets>} index
   * @returns {number} how many players gained a headshot
   */
  setPlayerAssets(index) {
    this.playerAssets = index || emptyPlayerAssets();
    const matched = applyPlayerAssets(this.playersById, this.playerAssets);
    if (matched > 0) this.emit('change', { reason: 'assets', matched });
    return matched;
  }

  // ------------------------------------------------------------------ getters

  get rounds() {
    return this.config.rounds;
  }

  get teamCount() {
    return this.config.teamCount;
  }

  get userTeamId() {
    return this.config.userTeamId;
  }

  get timerSeconds() {
    return this.config.timerSeconds;
  }

  /** All players still on the board. */
  get availablePlayers() {
    return Object.values(this.playersById).filter((p) => p.draftedBy === null);
  }

  /** 1-based round for the pick currently on the clock. */
  get currentRound() {
    return this.roundForPick(this.currentPick);
  }

  /** 1-based position inside the current round (1..teamCount). */
  get currentSlot() {
    return ((this.currentPick - 1) % this.teamCount) + 1;
  }

  /** Team id on the clock (snake order). */
  get currentTeamId() {
    return this.teamIdForPick(this.currentPick);
  }

  /** The Team object on the clock. */
  get currentTeam() {
    return this.teamById(this.currentTeamId);
  }

  get isUserOnClock() {
    return !this.complete && this.currentTeamId === this.userTeamId;
  }

  teamById(teamId) {
    return this.teams.find((team) => team.id === teamId);
  }

  /** @param {number} overall 1-based overall pick */
  roundForPick(overall) {
    return Math.min(this.rounds, Math.floor((overall - 1) / this.teamCount) + 1);
  }

  /**
   * Snake order: odd rounds run 1..N, even rounds run N..1.
   * Mirrors public.fsnv2_snake_team() in Postgres.
   * @param {number} overall 1-based overall pick
   * @returns {number} team id
   */
  teamIdForPick(overall) {
    return snakeTeamId(overall, this.teamCount, this.config.draftType);
  }

  /**
   * Inverse of `teamIdForPick`: the overall pick a team owns in a round.
   * This is what the board matrix uses, so every cell sits in its own team's
   * column — round 2 puts pick 13 under team 12 and pick 24 under team 1.
   */
  pickNumberFor(round, teamId) {
    return snakePickNumber(round, teamId, this.teamCount, this.config.draftType);
  }

  /** The Pick a team made in a given round, if it has been made yet. */
  pickForTeam(round, teamId) {
    const overall = this.pickNumberFor(round, teamId);
    return this.picks.find((pick) => pick.overall === overall);
  }

  /**
   * The next `count` picks after the one on the clock — drives the "next up"
   * strip so previews stay in sync with every selection.
   * @returns {Array<{overall: number, round: number, slot: number, teamId: number, team: import('./types.js').Team, isUser: boolean}>}
   */
  nextUp(count = 4) {
    const preview = [];
    for (let overall = this.currentPick + 1; overall <= this.totalPicks && preview.length < count; overall += 1) {
      const teamId = this.teamIdForPick(overall);
      preview.push({
        overall,
        round: this.roundForPick(overall),
        slot: ((overall - 1) % this.teamCount) + 1,
        teamId,
        team: this.teamById(teamId),
        isUser: teamId === this.userTeamId
      });
    }
    return preview;
  }

  /** @returns {import('./types.js').Pick|undefined} */
  pickAt(round, slot) {
    const overall = (round - 1) * this.teamCount + slot;
    return this.picks.find((pick) => pick.overall === overall);
  }

  /** Overall pick numbers a team still owns, in order. */
  upcomingPicksForTeam(teamId) {
    const upcoming = [];
    for (let overall = this.currentPick; overall <= this.totalPicks; overall += 1) {
      if (this.teamIdForPick(overall) === teamId) upcoming.push(overall);
    }
    return upcoming;
  }

  /** How many picks until the given team is back on the clock. */
  picksUntilTurn(teamId) {
    const next = this.upcomingPicksForTeam(teamId)[0];
    return next === undefined ? Infinity : next - this.currentPick;
  }

  // ------------------------------------------------------------------- clock

  /** (Re)starts the pick clock for whoever is on the clock. */
  startClock(seconds = this.config.timerSeconds) {
    if (this.complete) return this.clock;
    this.clock.start(seconds);
    this.emit('clock', { state: 'started', timer: this.clock });
    return this.clock;
  }

  pauseClock() {
    this.clock.pause();
    this.emit('clock', { state: 'paused', timer: this.clock });
    return this.clock;
  }

  resumeClock() {
    this.clock.resume();
    this.emit('clock', { state: 'resumed', timer: this.clock });
    return this.clock;
  }

  stopClock() {
    this.clock.stop();
    this.emit('clock', { state: 'stopped', timer: this.clock });
    return this.clock;
  }

  /**
   * Fired by PickTimer at 0:00 — takes the best available player by ADP and
   * advances the turn cleanly (the clock restarts for the next team inside
   * makePick()).
   */
  handleClockExpiry() {
    if (this.complete) return null;
    const player = this.bestAvailableByAdp();
    if (!player) return null;
    const pick = this.makePick(player.id, { auto: true, source: 'timer_expiry' });
    this.emit('expire', { pick, player });
    return pick;
  }

  /**
   * Best player left by draft position — lowest ADP number, i.e. the highest
   * ADP-ranked player still on the board. Prefers players who actually fit an
   * open roster slot, falling back to raw ADP if the roster shape blocks all of
   * them.
   * @param {number} [teamId] defaults to the team on the clock
   */
  bestAvailableByAdp(teamId = this.currentTeamId) {
    const available = this.availablePlayers.sort((a, b) => a.adp - b.adp);
    if (available.length === 0) return null;
    const counts = this.positionCounts(teamId);
    const fits = available.find(
      (player) =>
        counts[player.position] < POSITION_LIMITS[player.position] &&
        this.findOpenSlot(teamId, player.position)
    );
    return fits || available.find((player) => this.findOpenSlot(teamId, player.position)) || null;
  }

  // -------------------------------------------------------------- roster math

  /** @returns {Record<string, string|null>} slot key -> player id */
  rosterFor(teamId) {
    return this.rosters[teamId];
  }

  /** Counts of rostered players by position for a team. */
  positionCounts(teamId) {
    const counts = POSITIONS.reduce((acc, pos) => ({ ...acc, [pos]: 0 }), {});
    this.teamById(teamId).roster.forEach((playerId) => {
      counts[this.playersById[playerId].position] += 1;
    });
    return counts;
  }

  /**
   * Finds the slot a player should occupy: best matching starter slot first,
   * then the first open bench spot.
   * @returns {string|null} slot key or null when the roster is full
   */
  findOpenSlot(teamId, position) {
    const roster = this.rosters[teamId];
    const starter = ROSTER_SLOTS.find(
      (slot) => slot.starter && roster[slot.key] === null && slot.accepts.includes(position)
    );
    if (starter) return starter.key;
    const bench = ROSTER_SLOTS.find((slot) => !slot.starter && roster[slot.key] === null);
    return bench ? bench.key : null;
  }

  /** Projected points from the current starting lineup. */
  starterPoints(teamId) {
    const roster = this.rosters[teamId];
    return ROSTER_SLOTS.filter((slot) => slot.starter).reduce((sum, slot) => {
      const id = roster[slot.key];
      return sum + (id ? this.playersById[id].projection : 0);
    }, 0);
  }

  /** Summed VOR of everyone a team has rostered. */
  teamVor(teamId) {
    return round1(
      this.teamById(teamId).roster.reduce((sum, id) => sum + this.playersById[id].vor, 0)
    );
  }

  /** League table sorted by starter points — powers the League Overview view. */
  standings() {
    return this.teams
      .map((team) => ({
        team,
        picks: team.roster.length,
        starterPoints: Math.round(this.starterPoints(team.id)),
        vor: this.teamVor(team.id),
        counts: this.positionCounts(team.id)
      }))
      .sort((a, b) => b.starterPoints - a.starterPoints)
      .map((row, index) => ({ ...row, rank: index + 1 }));
  }

  /**
   * Need weights feed both the recommendation list and bot scoring.
   * Positions with unfilled starter slots are boosted; filled ones decay.
   * @returns {Record<string, number>}
   */
  needWeights(teamId) {
    const counts = this.positionCounts(teamId);
    const roundsLeft = this.rounds - this.currentRound + 1;
    /** @type {Record<string, number>} */
    const weights = {};

    POSITIONS.forEach((position) => {
      const required = STARTER_REQUIREMENTS[position] || 0;
      const owned = counts[position];
      const limit = POSITION_LIMITS[position];

      if (owned >= limit) {
        weights[position] = -999; // hard cap, never draft another
        return;
      }

      let weight = 0;
      if (owned < required) weight += 22 * (required - owned);
      else weight -= 8 * (owned - required); // depth is worth less than need

      // Kickers and defenses are dead weight until the final rounds.
      if (position === 'K' || position === 'DST') {
        const mustFill = roundsLeft <= 2 && owned === 0;
        weight = mustFill ? 400 : -260 + (this.currentRound >= this.rounds - 2 ? 320 : 0);
      }

      // A second QB/TE only matters once starters are set.
      if ((position === 'QB' || position === 'TE') && owned >= required) weight -= 30;

      weights[position] = weight;
    });

    return weights;
  }

  // ---------------------------------------------------------------- selecting

  /**
   * Drafts a player for the team currently on the clock, then advances the
   * turn: current pick moves forward, the clock restarts for the next team and
   * a `change` event repaints every on-the-clock indicator.
   *
   * @param {string} playerId
   * @param {{auto?: boolean, source?: 'manual'|'bot'|'timer_expiry'|'simulation'}} [meta]
   * @returns {import('./types.js').Pick}
   */
  makePick(playerId, meta = {}) {
    if (this.complete) throw new Error('Draft is already complete.');
    const player = this.playersById[playerId];
    if (!player) throw new Error(`Unknown player: ${playerId}`);
    if (player.draftedBy !== null) throw new Error(`${player.name} is already drafted.`);

    const teamId = this.currentTeamId;
    const slotKey = this.findOpenSlot(teamId, player.position);
    if (!slotKey) throw new Error('Roster is full.');

    const pick = createPick({
      overall: this.currentPick,
      round: this.currentRound,
      slot: this.currentSlot,
      teamId,
      playerId,
      auto: Boolean(meta.auto)
    });
    pick.source = meta.source || (meta.auto ? 'bot' : 'manual');
    pick.slotKey = slotKey;

    player.draftedBy = teamId;
    player.pickNumber = pick.overall;
    this.rosters[teamId][slotKey] = playerId;
    this.teamById(teamId).roster.push(playerId);
    this.picks.push(pick);

    // --- advance the turn ----------------------------------------------------
    if (pick.overall >= this.totalPicks) {
      this.complete = true;
      this.currentPick = this.totalPicks;
      this.clock.stop();
    } else {
      this.currentPick = pick.overall + 1;
      if (this.clock.running || this.clock.expired) this.clock.start(this.config.timerSeconds);
    }

    this.emit('change', { reason: 'pick', pick });
    return pick;
  }

  /** Reverts the most recent selection. */
  undo() {
    const pick = this.picks.pop();
    if (!pick) return null;

    const player = this.playersById[pick.playerId];
    player.draftedBy = null;
    player.pickNumber = null;

    const roster = this.rosters[pick.teamId];
    const slotKey = Object.keys(roster).find((key) => roster[key] === pick.playerId);
    if (slotKey) roster[slotKey] = null;

    const team = this.teamById(pick.teamId);
    team.roster = team.roster.filter((id) => id !== pick.playerId);

    this.complete = false;
    this.currentPick = pick.overall;
    this.emit('change', { reason: 'undo', pick });
    return pick;
  }

  /**
   * Bot selection: board value + roster need + a dash of randomness so two
   * simulations never look identical.
   * @returns {import('./types.js').Player|null}
   */
  botSelection(teamId = this.currentTeamId) {
    const weights = this.needWeights(teamId);
    const roster = this.rosters[teamId];
    const rosterFull = Object.values(roster).every((slot) => slot !== null);
    if (rosterFull) return null;

    const spread = this.config.botRandomness * 40;
    let best = null;
    let bestScore = -Infinity;

    this.availablePlayers.forEach((player) => {
      const weight = weights[player.position];
      if (weight <= -900) return; // position capped
      if (!this.findOpenSlot(teamId, player.position)) return;

      const score = draftValue(player) + weight + (Math.random() - 0.5) * spread;
      if (score > bestScore) {
        bestScore = score;
        best = player;
      }
    });

    return best;
  }

  /**
   * Makes one automated pick for whoever is on the clock.
   * @param {{strategy?: 'vor'|'adp', source?: string}} [options]
   */
  autoPick({ strategy = 'vor', source } = {}) {
    if (this.complete) return null;
    const player = strategy === 'adp' ? this.bestAvailableByAdp() : this.botSelection();
    if (!player) return null;
    return this.makePick(player.id, { auto: true, source: source || (strategy === 'adp' ? 'timer_expiry' : 'bot') });
  }

  /**
   * Advances the draft until the user's team is on the clock (or the draft
   * ends). Respects `autoDraftUser`.
   */
  advanceToUser({ maxPicks = this.totalPicks } = {}) {
    let made = 0;
    while (!this.complete && made < maxPicks) {
      if (this.isUserOnClock && !this.autoDraftUser) break;
      if (!this.autoPick()) break;
      made += 1;
    }
    return made;
  }

  /** Simulates every remaining pick in the current round. */
  simulateRound() {
    const targetRound = this.currentRound;
    let made = 0;
    while (!this.complete && this.currentRound === targetRound) {
      if (this.isUserOnClock && !this.autoDraftUser) break;
      if (!this.autoPick()) break;
      made += 1;
    }
    return made;
  }

  /** Simulates the entire remaining draft. */
  simulateAll() {
    let made = 0;
    while (!this.complete) {
      if (this.isUserOnClock && !this.autoDraftUser) break;
      if (!this.autoPick()) break;
      made += 1;
    }
    return made;
  }

  /** Top recommendations for a team, need-adjusted. */
  recommendations(teamId = this.currentTeamId, limit = 5) {
    const weights = this.needWeights(teamId);
    const eligible = this.availablePlayers.filter(
      (player) => weights[player.position] > -900 && this.findOpenSlot(teamId, player.position)
    );
    return recommendPlayers(eligible, weights, limit);
  }

  /**
   * Replays a persisted pick list (from Supabase or localStorage) onto a fresh
   * board. Picks are applied in pick_number order and anything that no longer
   * validates is skipped, so a corrupt row can never wedge the room.
   * @param {Array<{pick_number?: number, overall?: number, player_id?: string, playerId?: string, auto?: boolean, source?: string}>} rows
   */
  hydrate(rows = []) {
    this.reset({ silent: true });
    const ordered = [...rows].sort(
      (a, b) => (a.pick_number ?? a.overall) - (b.pick_number ?? b.overall)
    );
    let applied = 0;
    ordered.forEach((row) => {
      const playerId = row.player_id ?? row.playerId;
      try {
        this.makePick(playerId, { auto: row.auto, source: row.source });
        applied += 1;
      } catch {
        /* skip unreplayable rows */
      }
    });
    this.emit('change', { reason: 'hydrate', applied });
    return applied;
  }

  /** Serialisable snapshot — used for localStorage and DB sync. */
  toJSON() {
    return {
      teamCount: this.teamCount,
      rounds: this.rounds,
      userTeamId: this.userTeamId,
      timerSeconds: this.timerSeconds,
      currentPick: this.currentPick,
      complete: this.complete,
      picks: this.picks.map((pick) => ({
        pick_number: pick.overall,
        round: pick.round,
        team_id: pick.teamId,
        player_id: pick.playerId,
        auto: pick.auto,
        source: pick.source,
        picked_at: new Date(pick.timestamp).toISOString()
      }))
    };
  }

  // ------------------------------------------------------------------- events

  /** @param {string} event @param {Function} handler */
  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const handlers = this.listeners.get(event) || [];
    this.listeners.set(
      event,
      handlers.filter((fn) => fn !== handler)
    );
  }

  emit(event, payload) {
    (this.listeners.get(event) || []).forEach((handler) => handler(payload, this));
  }
}

function clonePlayers(players) {
  return players.map((player) => ({ ...player }));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
