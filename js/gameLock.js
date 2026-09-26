/**
 * gameLock.js
 * -----------------------------------------------------------------------------
 * When is a player's week over? Everything that answers that question lives
 * here, once.
 *
 * A fantasy lineup is only honest if a player stops being movable the moment
 * their real game starts — otherwise a manager can watch the Packers put up 31
 * on Thursday night and *then* decide to start Josh Jacobs. `isPlayerLocked()`
 * is the single predicate behind that rule, and it is deliberately the same code
 * in every layer:
 *
 *   browser UI        js/uiRenderer.js  -> lock icons, unselectable rows
 *   lineup manager    js/lineup.js      -> refuses the swap, explains why
 *   API route         api/roster/swap.js -> 400 before the mutation RPC
 *   database          fsnv2_swap_lineup -> re-checks it inside the write
 *   ingestion         lib/services/normalize.ts -> one kickoff parser
 *
 * It is a plain ES module with JSDoc types rather than TypeScript for exactly
 * that reason: the browser imports it with no build step, Node imports it in the
 * test-suite, esbuild inlines it into the Vercel Function, and `gameLock.d.ts`
 * next door lets the `.ts` modules import it under `npm run typecheck`. A
 * duplicated copy of this logic in TypeScript would be a copy that drifts, and
 * the whole point is that the client and the server never disagree about whether
 * a game has started. The SQL mirror in
 * supabase/migrations/0013_fsnv2_lineup_locks.sql is the one unavoidable
 * restatement — it is what guards the write itself, and it is commented as a
 * mirror so the two stay in step.
 *
 * Feed shapes
 * -----------
 * Providers cannot agree on how to spell a kickoff, so every reader here is
 * alias-tolerant and the caller never has to pre-map:
 *
 *   Tank01     { gameID, home: 'MIN', away: 'CHI', gameDate: '20260913',
 *                gameTime: '1:00p', gameTime_epoch: '1789318800.0',
 *                gameStatus: 'Completed' }
 *   Sleeper    { home_team, away_team, start_time: 1789318800000, status: 'pre_game' }
 *   fsnv2      { home_team, away_team, kickoff: '2026-09-13T17:00:00Z',
 *                status: 'final' }   (fsnv2.nfl_matchups / GameRow)
 *
 * Postponed and canceled games are treated as *unlocked* even once their
 * scheduled kickoff has passed: the game never happened, so the roster spot is
 * still the manager's to fill. That is the one place this file knowingly
 * departs from a literal "now >= kickoff" reading.
 */

/* ---------------------------------------------------------------- statuses */

/** Our canonical statuses — the same five `fsnv2.nfl_matchups.status` allows. */
export const GAME_STATUSES = ['scheduled', 'in_progress', 'final', 'postponed', 'canceled'];

/** Statuses that mean the ball is in the air, or was. */
export const LOCKED_GAME_STATUSES = ['in_progress', 'final'];

/**
 * Vendor status strings, in the order they have to be tested — "Final/OT"
 * before the `q[1-4]` live pattern, "not started" before "started".
 * Mirrors GAME_STATUS_ALIASES in lib/services/normalize.ts, which is derived
 * from this list.
 */
const STATUS_ALIASES = [
  [/^(completed|complete|final|closed|post[-_\s]?game|f\/ot)/i, 'final'],
  [/(live|in\s*progress|progress|halftime|q[1-4]|\d+(st|nd|rd|th)\s*quarter)/i, 'in_progress'],
  [/postponed|suspended|delayed/i, 'postponed'],
  [/cancel/i, 'canceled'],
  [/scheduled|not\s*started|pre[-_\s]?game|upcoming|^pre$/i, 'scheduled']
];

/**
 * A provider's status string reduced to one of GAME_STATUSES.
 *
 * @param {unknown} value
 * @returns {string|null} null when the feed said nothing useful
 */
export function normalizeGameStatus(value) {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  if (!raw) return null;
  for (const [pattern, status] of STATUS_ALIASES) {
    if (pattern.test(raw)) return status;
  }
  return null;
}

/** The status field, under any of the names the feeds use. */
export function gameStatusOf(game) {
  if (!game || typeof game !== 'object') return null;
  return normalizeGameStatus(
    game.gameStatus ?? game.game_status ?? game.status ?? game.gameState ?? game.state
  );
}

/** True for a status that means the game is being played, or has been. */
export function isLockedStatus(status) {
  return LOCKED_GAME_STATUSES.includes(normalizeGameStatus(status) ?? '');
}

/* ----------------------------------------------------------------- kickoff */

/**
 * Epoch value (seconds or milliseconds, number or string) to epoch millis.
 * Anything outside 2001-2286 is treated as noise rather than a date.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function epochMs(value) {
  const raw =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number.parseFloat(value.trim())
        : Number.NaN;
  if (!Number.isFinite(raw) || raw <= 0) return null;

  // 1e9 s = 2001-09-09, 1e10 s = 2286-11-20. Above that it can only be millis.
  if (raw >= 1_000_000_000 && raw < 10_000_000_000) return Math.round(raw * 1000);
  if (raw >= 1_000_000_000_000 && raw < 10_000_000_000_000) return Math.round(raw);
  return null;
}

/**
 * US Eastern's UTC offset in hours for a date, the way a schedule feed means
 * it: EDT (-4) through the first week of November, EST (-5) after it. Kickoff
 * times are quoted in Eastern and nothing in the NFL calendar lands close
 * enough to the DST boundary for the approximation to matter — and a feed that
 * sends an epoch is always preferred over this path anyway.
 *
 * @param {number} month 1-12
 * @param {number} day 1-31
 * @returns {number} hours to add to Eastern to get UTC
 */
export function easternOffsetHours(month, day) {
  return month > 11 || month < 3 || (month === 11 && day > 7) ? 5 : 4;
}

/**
 * Kickoff to epoch millis from whichever fields the feed sent:
 *   epoch seconds or millis, an ISO-8601 string, or Tank01's split
 *   `gameDate` "20251005" + `gameTime` "1:00p" (US Eastern).
 *
 * @param {{epoch?: unknown, iso?: unknown, date?: unknown, time?: unknown}} input
 * @returns {number|null}
 */
export function parseKickoff({ epoch, iso, date, time } = {}) {
  const fromEpoch = epochMs(epoch);
  if (fromEpoch !== null) return fromEpoch;

  if (typeof iso === 'string' && iso.trim() !== '') {
    const parsed = new Date(iso.trim());
    if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  }

  const day = typeof date === 'string' ? date.trim() : typeof date === 'number' ? String(date) : '';
  if (!day) return null;
  const parts = /^(\d{4})(\d{2})(\d{2})$/.exec(day) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!parts) return null;

  const year = Number.parseInt(parts[1], 10);
  const month = Number.parseInt(parts[2], 10);
  const dayNum = Number.parseInt(parts[3], 10);

  // No clock in the feed: 1:00p Eastern is the default NFL kickoff.
  let hour = 13;
  let minute = 0;
  const clock = typeof time === 'string' ? /^(\d{1,2}):(\d{2})\s*([ap])?/i.exec(time.trim()) : null;
  if (clock) {
    hour = Number.parseInt(clock[1], 10);
    minute = Number.parseInt(clock[2], 10);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === 'p' && hour < 12) hour += 12;
    if (meridiem === 'a' && hour === 12) hour = 0;
  }

  return Date.UTC(year, month - 1, dayNum, hour + easternOffsetHours(month, dayNum), minute);
}

/**
 * When a game object says it starts, in epoch millis.
 *
 * @param {Record<string, any>} game
 * @returns {number|null} null when the feed carries no usable kickoff
 */
export function gameStartTimestamp(game) {
  if (!game || typeof game !== 'object') return null;
  return parseKickoff({
    epoch:
      game.gameTimeEpoch ??
      game.gameTime_epoch ??
      game.kickoffEpoch ??
      game.kickoff_epoch ??
      game.startTimeEpoch ??
      game.start_time ??
      game.startTime ??
      game.epoch,
    iso:
      game.gameTimeISO ??
      game.gameTimeIso ??
      game.kickoff ??
      game.kickoffIso ??
      game.gameDateTime ??
      game.datetime ??
      game.startTimeIso,
    date: game.gameDate ?? game.game_date ?? game.date,
    time: game.gameTime ?? game.game_time ?? game.time
  });
}

/* ------------------------------------------------------------------- teams */

/** Team abbreviations are compared uppercase; these mean "no game". */
const NO_TEAM = new Set(['', 'FA', 'BYE', 'NONE', 'NULL', 'UNDEFINED']);

function abbr(value) {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return NO_TEAM.has(upper) ? null : upper;
}

/**
 * The NFL team a player plays for. `teamAbv` is Tank01's spelling, `team` is
 * ours (js/types.js), and the rest are what other feeds use.
 *
 * @param {Record<string, any>|string|null|undefined} player
 * @returns {string|null} null for a free agent or an unknown team
 */
export function playerTeamAbbr(player) {
  if (typeof player === 'string') return abbr(player);
  if (!player || typeof player !== 'object') return null;
  return (
    abbr(player.teamAbv) ??
    abbr(player.team) ??
    abbr(player.teamAbbr) ??
    abbr(player.team_abbr) ??
    abbr(player.nflTeam) ??
    abbr(player.pro_team) ??
    null
  );
}

/** A player's display name, for the error message and the lock tooltip. */
export function playerName(player) {
  if (typeof player === 'string') return player;
  if (!player || typeof player !== 'object') return 'Player';
  return (
    player.name ??
    player.longName ??
    player.full_name ??
    player.playerName ??
    player.id ??
    'Player'
  );
}

/** The two teams in a game, uppercase, home first. */
export function gameTeams(game) {
  if (!game || typeof game !== 'object') return [];
  const home = abbr(game.home ?? game.home_team ?? game.homeTeam ?? game.teamAbvHome);
  const away = abbr(game.away ?? game.away_team ?? game.awayTeam ?? game.teamAbvAway);
  const fromId = home && away ? [] : teamsFromGameId(game.gameID ?? game.game_id ?? game.external_id);
  return [home ?? fromId[0] ?? null, away ?? fromId[1] ?? null].filter(
    (value) => value !== null
  );
}

/** "20260913_CHI@MIN" -> ['MIN', 'CHI'] (home first), or []. */
function teamsFromGameId(value) {
  if (typeof value !== 'string') return [];
  const match = /_([A-Z]{2,4})@([A-Z]{2,4})$/.exec(value.trim().toUpperCase());
  return match ? [match[2], match[1]] : [];
}

/* ---------------------------------------------------------------- schedule */

/**
 * Pulls the game list out of whatever the caller had to hand: a bare array, a
 * Tank01 `{ statusCode, body }` envelope, a `{ games }` / `{ matchups }` wrapper,
 * or an already-built index from `buildGameSchedule()`.
 *
 * @param {unknown} payload
 * @returns {Array<Record<string, any>>}
 */
export function normalizeGames(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.filter((game) => game && typeof game === 'object');
  if (typeof payload !== 'object') return [];

  const source = /** @type {Record<string, any>} */ (payload);
  if (Array.isArray(source.games)) return normalizeGames(source.games);
  if (Array.isArray(source.body)) return normalizeGames(source.body);
  if (Array.isArray(source.matchups)) return normalizeGames(source.matchups);
  if (Array.isArray(source.schedule)) return normalizeGames(source.schedule);

  // Tank01 also returns getNFLGamesForWeek keyed by gameID on some plans.
  const values = Object.values(source);
  if (values.length > 0 && values.every((value) => value && typeof value === 'object')) {
    return /** @type {Array<Record<string, any>>} */ (values);
  }
  return [];
}

/**
 * A week's games indexed by team abbreviation, so a lock check is a map lookup
 * instead of a scan. `isPlayerLocked()` accepts either this or the raw payload;
 * building it once is worth it when a whole roster is being rendered.
 *
 * @param {unknown} payload
 * @returns {{games: Array<Record<string, any>>, byTeam: Map<string, Record<string, any>>, isGameSchedule: true}}
 */
export function buildGameSchedule(payload) {
  if (payload && typeof payload === 'object' && /** @type {any} */ (payload).isGameSchedule) {
    return /** @type {any} */ (payload);
  }

  const games = normalizeGames(payload);
  const byTeam = new Map();
  games.forEach((game) => {
    gameTeams(game).forEach((team) => {
      // First game wins: a team plays once a week, and a duplicated row (a
      // re-synced week) carries the same kickoff anyway.
      if (!byTeam.has(team)) byTeam.set(team, game);
    });
  });
  return { games, byTeam, isGameSchedule: true };
}

/**
 * The game a player's team plays in this schedule, or null on a BYE.
 *
 * @param {Record<string, any>|string|null|undefined} player
 * @param {unknown} gameSchedule
 * @returns {Record<string, any>|null}
 */
export function gameForPlayer(player, gameSchedule) {
  const team = playerTeamAbbr(player);
  if (!team) return null;
  return buildGameSchedule(gameSchedule).byTeam.get(team) ?? null;
}

/* ------------------------------------------------------------------- locks */

/**
 * Why a player is (or is not) movable. The UI reads `reason` for the tooltip;
 * everything else only needs `locked`.
 *
 * @typedef {Object} LockState
 * @property {boolean} locked
 * @property {'started'|'in_progress'|'final'|'scheduled'|'bye'|'unknown'|'postponed'|'canceled'} reason
 * @property {string|null} status      normalized game status, when the feed sent one
 * @property {number|null} kickoff     epoch millis, when the feed sent one
 * @property {Record<string, any>|null} game
 * @property {string|null} team
 */

/**
 * The full lock picture for one player.
 *
 * @param {Record<string, any>|string|null|undefined} player
 * @param {unknown} gameSchedule a week's games (any shape `normalizeGames` reads)
 * @param {number} [now] epoch millis
 * @returns {LockState}
 */
export function playerLockState(player, gameSchedule, now = Date.now()) {
  const team = playerTeamAbbr(player);
  const game = team ? buildGameSchedule(gameSchedule).byTeam.get(team) ?? null : null;

  // No team or no game this week: a BYE (or a free agent) is never locked.
  if (!game) {
    return { locked: false, reason: 'bye', status: null, kickoff: null, game: null, team };
  }

  const status = gameStatusOf(game);
  const kickoff = gameStartTimestamp(game);
  const base = { status, kickoff, game, team };

  // A game that was called off never starts, whatever the clock says.
  if (status === 'postponed' || status === 'canceled') {
    return { locked: false, reason: status, ...base };
  }
  if (status === 'in_progress' || status === 'final') {
    return { locked: true, reason: status, ...base };
  }
  if (kickoff !== null) {
    return { locked: now >= kickoff, reason: now >= kickoff ? 'started' : 'scheduled', ...base };
  }

  // A game with no kickoff and no status tells us nothing — stay out of the
  // manager's way rather than locking a roster on missing data.
  return { locked: false, reason: 'unknown', ...base };
}

/**
 * Is this player's week already under way?
 *
 * Returns true once `now` has reached kickoff, or as soon as the feed calls the
 * game in progress / completed / final. Returns false before kickoff, on a BYE,
 * and for a postponed or canceled game.
 *
 * @param {Record<string, any>|string|null|undefined} player e.g. { name, teamAbv }
 * @param {unknown} gameSchedule the current week's game schedule
 * @param {number} [now] epoch millis — injectable so tests and the API agree
 * @returns {boolean}
 */
export function isPlayerLocked(player, gameSchedule, now = Date.now()) {
  return playerLockState(player, gameSchedule, now).locked;
}

/** The rejection text every layer shows — one wording, one place. */
export function lockedPlayerMessage(player) {
  return `Cannot move player: ${playerName(player)} is locked because their game has already started.`;
}

/**
 * Short human label for the lock chip: "🔒 in progress", "🔒 final",
 * "🔒 started 1:00 PM".
 *
 * @param {LockState} state
 * @returns {string}
 */
export function lockLabel(state) {
  if (!state?.locked) return '';
  if (state.reason === 'in_progress') return 'game in progress';
  if (state.reason === 'final') return 'game final';
  if (state.kickoff === null) return 'game started';
  const when = new Date(state.kickoff).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  });
  return `kicked off ${when}`;
}

/**
 * Lock state for every slot on a roster, keyed by slot. What the roster
 * renderer needs in one pass.
 *
 * @param {Record<string, string|null>} roster slot key -> player id
 * @param {Record<string, Record<string, any>>} playersById
 * @param {unknown} gameSchedule
 * @param {number} [now]
 * @returns {Map<string, LockState>}
 */
export function rosterLockStates(roster, playersById, gameSchedule, now = Date.now()) {
  const schedule = buildGameSchedule(gameSchedule);
  const states = new Map();
  Object.entries(roster ?? {}).forEach(([slot, playerId]) => {
    if (!playerId) return;
    const player = playersById?.[playerId];
    if (!player) return;
    states.set(slot, playerLockState(player, schedule, now));
  });
  return states;
}

/* ------------------------------------------------- the live week registry */

/**
 * week -> that week's games, installed from the synced schedule on boot.
 *
 * Module state, deliberately, and for the same reason `liveSlate` in
 * js/nflTeams.js is: the lock is asked about from the roster renderer, the
 * lineup manager and the season engine, and threading a store through all three
 * would be plumbing with no payoff. It is set once from `fsnv2_nfl_schedule`
 * (js/app.js) and read everywhere.
 *
 * Nothing is invented behind it. A week the sync has not stored has no games,
 * and a week with no games locks nobody — the same posture js/nflTeams.js takes
 * with a missing fixture, where '—' is shown rather than a made-up opponent.
 * `hasLockSchedule(week)` is how a caller tells "nothing has started" from
 * "we do not know".
 *
 * @type {Map<number, import('./gameLock.js').GameSchedule>|null}
 */
let lockSchedule = null;

/**
 * Installs the kickoff times. Takes `week -> games[]` (what
 * `createLiveData().gamesByWeek` returns), and indexes each week by team.
 *
 * @param {Map<number, Array<Record<string, any>>>|null} byWeek
 */
export function setLockSchedule(byWeek) {
  if (!byWeek || byWeek.size === 0) {
    lockSchedule = null;
    return 0;
  }
  lockSchedule = new Map(
    [...byWeek.entries()].map(([week, games]) => [Number(week), buildGameSchedule(games)])
  );
  return lockSchedule.size;
}

/** True when the week's kickoff times are known. */
export function hasLockSchedule(week) {
  return Boolean(lockSchedule?.has(Number(week)));
}

/** The weeks kickoff times are known for. */
export function lockScheduleWeeks() {
  return lockSchedule ? [...lockSchedule.keys()].sort((a, b) => a - b) : [];
}

/** The indexed games for a week — an empty schedule when the week is unknown. */
export function lockScheduleFor(week) {
  return lockSchedule?.get(Number(week)) ?? EMPTY_SCHEDULE;
}

const EMPTY_SCHEDULE = buildGameSchedule([]);

/**
 * Has this player's week started, according to the installed schedule?
 *
 * @param {Record<string, any>|string|null|undefined} player
 * @param {number} week
 * @param {number} [now]
 */
export function isLockedInWeek(player, week, now = Date.now()) {
  return isPlayerLocked(player, lockScheduleFor(week), now);
}

/** The same question with the reason attached, for the 🔒 tooltip. */
export function lockStateInWeek(player, week, now = Date.now()) {
  return playerLockState(player, lockScheduleFor(week), now);
}

/**
 * Lock state for every filled slot of a roster, keyed by slot — one pass for a
 * whole roster render.
 *
 * @param {Record<string, string|null>} roster
 * @param {Record<string, Record<string, any>>} playersById
 * @param {number} week
 * @param {number} [now]
 */
export function rosterLocksInWeek(roster, playersById, week, now = Date.now()) {
  return rosterLockStates(roster, playersById, lockScheduleFor(week), now);
}
