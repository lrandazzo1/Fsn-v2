/**
 * draftEngine.js
 * -----------------------------------------------------------------------------
 * Authoritative state manager for a 12-team, 15-round snake draft.
 *
 * The engine owns all mutations (pick, auto-pick, undo, reset) and emits a
 * `change` event afterwards. The UI layer only ever reads from it, which keeps
 * rendering a pure function of state.
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

const DEFAULTS = {
  teamCount: 12,
  rounds: 15,
  userTeamId: 1,
  /** Higher = more chaotic bots. 0 = always takes the top board value. */
  botRandomness: 0.18
};

export class DraftEngine {
  /**
   * @param {Partial<typeof DEFAULTS> & {players?: import('./types.js').Player[]}} [options]
   */
  constructor(options = {}) {
    this.config = { ...DEFAULTS, ...options };
    /** @type {Map<string, Function[]>} */
    this.listeners = new Map();
    this.reset();
  }

  // ---------------------------------------------------------------- lifecycle

  /** Rebuilds a fresh draft with the current configuration. */
  reset() {
    const { teamCount, rounds, userTeamId, players } = this.config;

    const pool = enrichPlayers(players ? clonePlayers(players) : loadPlayers(), teamCount);

    /** @type {Record<string, import('./types.js').Player>} */
    this.playersById = {};
    pool.forEach((player) => {
      this.playersById[player.id] = player;
    });

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

    this.emit('change', { reason: 'reset' });
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

  /** All players still on the board. */
  get availablePlayers() {
    return Object.values(this.playersById).filter((p) => p.draftedBy === null);
  }

  /** 1-based round for the pick currently on the clock. */
  get currentRound() {
    return Math.min(this.rounds, Math.floor((this.currentPick - 1) / this.teamCount) + 1);
  }

  /** Team id on the clock (snake order). */
  get currentTeamId() {
    return this.teamIdForPick(this.currentPick);
  }

  get isUserOnClock() {
    return !this.complete && this.currentTeamId === this.userTeamId;
  }

  /**
   * Snake order: odd rounds run 1..N, even rounds run N..1.
   * @param {number} overall 1-based overall pick
   * @returns {number} team id
   */
  teamIdForPick(overall) {
    const index = overall - 1;
    const round = Math.floor(index / this.teamCount);
    const slot = index % this.teamCount;
    return round % 2 === 0 ? slot + 1 : this.teamCount - slot;
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

  // -------------------------------------------------------------- roster math

  /** @returns {Record<string, string|null>} slot key -> player id */
  rosterFor(teamId) {
    return this.rosters[teamId];
  }

  /** Counts of rostered players by position for a team. */
  positionCounts(teamId) {
    const counts = POSITIONS.reduce((acc, pos) => ({ ...acc, [pos]: 0 }), {});
    this.teams
      .find((t) => t.id === teamId)
      .roster.forEach((playerId) => {
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
   * Drafts a player for the team currently on the clock.
   * @param {string} playerId
   * @param {{auto?: boolean}} [meta]
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

    const index = this.currentPick - 1;
    const pick = createPick({
      overall: this.currentPick,
      round: Math.floor(index / this.teamCount) + 1,
      slot: (index % this.teamCount) + 1,
      teamId,
      playerId,
      auto: Boolean(meta.auto)
    });

    player.draftedBy = teamId;
    player.pickNumber = pick.overall;
    this.rosters[teamId][slotKey] = playerId;
    this.teams.find((t) => t.id === teamId).roster.push(playerId);
    this.picks.push(pick);

    this.currentPick += 1;
    if (this.currentPick > this.totalPicks) {
      this.complete = true;
      this.currentPick = this.totalPicks;
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

    const team = this.teams.find((t) => t.id === pick.teamId);
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

  /** Makes one automated pick for whoever is on the clock. */
  autoPick() {
    if (this.complete) return null;
    const player = this.botSelection();
    if (!player) return null;
    return this.makePick(player.id, { auto: true });
  }

  /**
   * Advances the draft until the user's team is on the clock (or the draft
   * ends). Respects `autoDraftUser` — when enabled the user's picks are made
   * by the bot too.
   * @param {{maxPicks?: number}} [options]
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

  /** Serialisable snapshot — handy for persistence or debugging. */
  toJSON() {
    return {
      teamCount: this.teamCount,
      rounds: this.rounds,
      userTeamId: this.userTeamId,
      currentPick: this.currentPick,
      complete: this.complete,
      picks: this.picks,
      rosters: this.rosters
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
