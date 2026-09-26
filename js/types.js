/**
 * types.js
 * -----------------------------------------------------------------------------
 * Core data structures for the FSN v2 Draft & League Engine.
 *
 * The app is written in plain ES modules (no build step) so JSDoc typedefs are
 * used instead of TypeScript interfaces. Every factory below returns a plain
 * object so state stays serialisable (structuredClone / JSON friendly).
 */

/** @typedef {'QB'|'RB'|'WR'|'TE'|'K'|'DST'} Position */

/**
 * @typedef {Object} Player
 * @property {string}   id            Stable identifier ("p-0042").
 * @property {string}   name          Display name.
 * @property {Position} position      Primary position.
 * @property {string}   team          NFL team abbreviation.
 * @property {number}   projection    Projected season fantasy points (PPR).
 * @property {number}   vor           Value Over Replacement (filled by vorMath).
 * @property {number}   vorRank       Overall rank by VOR (1 = best).
 * @property {number}   posRank       Rank within position (1 = best).
 * @property {number}   tier          Tier bucket within position (1 = elite).
 * @property {number|null} sleeperAdp Sleeper scoring-specific ADP, when supplied.
 * @property {number|null} searchRank Sleeper search rank, when supplied.
 * @property {number}   adp           Effective market rank (999 when missing).
 * @property {string|null} headshotUrl Player headshot (fsnv2.players.headshot_url).
 * @property {string|null} espnId      ESPN player id, when the audit resolved one.
 * @property {number|null} draftedBy  Team id that rostered the player, or null.
 * @property {number|null} pickNumber Overall pick number used, or null.
 */

/**
 * @typedef {Object} Team
 * @property {number}  id        1-based team id.
 * @property {string}  name      Franchise name.
 * @property {string}  abbr      Short label used on the draft board.
 * @property {boolean} isUser    True for the human-controlled franchise.
 * @property {string[]} roster   Player ids in the order they were drafted.
 */

/**
 * @typedef {Object} Pick
 * @property {number} overall   1-based overall pick number.
 * @property {number} round     1-based round number.
 * @property {number} slot      1-based slot inside the round.
 * @property {number} teamId    Team that owns the pick.
 * @property {string} playerId  Player selected.
 * @property {boolean} auto     True when made by the bot engine.
 * @property {number} timestamp Epoch millis of the selection.
 */

/**
 * @typedef {Object} DraftState
 * @property {number}  teamCount
 * @property {number}  rounds
 * @property {number}  userTeamId
 * @property {number}  currentPick     1-based overall pick on the clock.
 * @property {Team[]}  teams
 * @property {Pick[]}  picks
 * @property {Record<string, Player>} playersById
 * @property {boolean} complete
 */

/** Canonical position list, ordered the way analysts read a board. */
export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];

/** Positions eligible for the FLEX slot. */
export const FLEX_POSITIONS = ['RB', 'WR', 'TE'];

/**
 * Starting lineup + bench template. 9 starters + 6 bench = 15 rounds.
 * `key` is unique so two RB slots can be tracked independently.
 */
export const ROSTER_SLOTS = [
  { key: 'QB', label: 'QB', accepts: ['QB'], starter: true },
  { key: 'RB1', label: 'RB', accepts: ['RB'], starter: true },
  { key: 'RB2', label: 'RB', accepts: ['RB'], starter: true },
  { key: 'WR1', label: 'WR', accepts: ['WR'], starter: true },
  { key: 'WR2', label: 'WR', accepts: ['WR'], starter: true },
  { key: 'TE', label: 'TE', accepts: ['TE'], starter: true },
  { key: 'FLEX', label: 'FLEX', accepts: FLEX_POSITIONS, starter: true },
  { key: 'DST', label: 'DST', accepts: ['DST'], starter: true },
  { key: 'K', label: 'K', accepts: ['K'], starter: true },
  { key: 'BN1', label: 'BENCH', accepts: POSITIONS, starter: false },
  { key: 'BN2', label: 'BENCH', accepts: POSITIONS, starter: false },
  { key: 'BN3', label: 'BENCH', accepts: POSITIONS, starter: false },
  { key: 'BN4', label: 'BENCH', accepts: POSITIONS, starter: false },
  { key: 'BN5', label: 'BENCH', accepts: POSITIONS, starter: false },
  { key: 'BN6', label: 'BENCH', accepts: POSITIONS, starter: false }
];

/** Number of starters required at each position (used for roster needs). */
export const STARTER_REQUIREMENTS = ROSTER_SLOTS.filter((s) => s.starter).reduce(
  (acc, slot) => {
    slot.accepts.forEach((pos) => {
      acc[pos] = (acc[pos] || 0) + (slot.accepts.length === 1 ? 1 : 0);
    });
    return acc;
  },
  /** @type {Record<Position, number>} */ ({})
);

/** Hard caps so bots never hoard a position. */
export const POSITION_LIMITS = { QB: 2, RB: 6, WR: 7, TE: 2, K: 1, DST: 1 };

/** Default franchise names for the 12-team league. */
export const DEFAULT_TEAM_NAMES = [
  'Gridiron Goats',
  'Neon Knights',
  'Steel Vipers',
  'Coastal Krakens',
  'Midnight Mavericks',
  'Rampart Rhinos',
  'Highland Hawks',
  'Delta Dragons',
  'Iron Harbor',
  'Sunset Surge',
  'Canyon Coyotes',
  'Polar Pioneers'
];

/**
 * @param {Partial<Player> & {name: string, position: Position, team: string, projection: number}} input
 * @returns {Player}
 */
export function createPlayer(input) {
  return {
    id: input.id,
    name: input.name,
    position: input.position,
    team: input.team,
    projection: input.projection,
    vor: input.vor ?? 0,
    vorRank: input.vorRank ?? 0,
    posRank: input.posRank ?? 0,
    tier: input.tier ?? 1,
    sleeperAdp: input.sleeperAdp ?? null,
    searchRank: input.searchRank ?? null,
    adp: input.adp ?? 999,
    // Imagery is merged in from the database (js/playerAssets.js) — the local
    // pool has none, so the fields exist and start null rather than missing.
    headshotUrl: input.headshotUrl ?? null,
    espnId: input.espnId ?? null,
    draftedBy: input.draftedBy ?? null,
    pickNumber: input.pickNumber ?? null
  };
}

/**
 * @param {number} id
 * @param {string} name
 * @param {boolean} isUser
 * @returns {Team}
 */
export function createTeam(id, name, isUser = false) {
  return {
    id,
    name,
    abbr: abbreviateTeamName(name),
    isUser,
    roster: []
  };
}

/**
 * @param {Object} input
 * @returns {Pick}
 */
export function createPick({ overall, round, slot, teamId, playerId, auto }) {
  return {
    overall,
    round,
    slot,
    teamId,
    playerId,
    auto: Boolean(auto),
    timestamp: Date.now()
  };
}

/**
 * Builds an empty roster map keyed by slot: { QB: playerId|null, ... }.
 * @returns {Record<string, string|null>}
 */
export function createRosterSlots() {
  return ROSTER_SLOTS.reduce((acc, slot) => {
    acc[slot.key] = null;
    return acc;
  }, /** @type {Record<string, string|null>} */ ({}));
}

/** "Gridiron Goats" -> "GRI" */
export function abbreviateTeamName(name) {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return (words[0][0] + words[1].slice(0, 2)).toUpperCase();
}
