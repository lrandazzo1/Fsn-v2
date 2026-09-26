/**
 * liveData.js
 * -----------------------------------------------------------------------------
 * Turns the rows the Supabase read RPCs return into the shapes the rest of the
 * app already speaks:
 *
 *   fsnv2_players       -> a draft pool, same shape as playerData.loadPlayers()
 *   fsnv2_projections   -> week -> player -> real Tank01 fantasy points
 *   fsnv2_nfl_schedule  -> week -> team  -> { opponent, home }
 *
 * Nothing here talks to the network; persistence.js does the fetching and hands
 * the three row sets over. That keeps this module pure and testable, and means
 * a failed fetch simply never reaches it — app.js falls back to the static pool.
 *
 * Matching
 * --------
 * The two id spaces in fsnv2.players do not overlap (`p-0007` vs
 * `tank01-3917315`), and the projections rows carry names rather than the
 * app's ids. Everything is therefore matched the same way the database does it
 * in migration 0006: a punctuation-stripped name key plus the position. Team
 * defenses are the exception — the provider names them "MIN D/ST" where the
 * pool says "Vikings D/ST" — so those match on team abbreviation instead, which
 * is unique per week anyway.
 */

/**
 * The canonical abbreviation comes from the one alias table the UI already keys
 * on (TEAM_ALIASES in nflTeams.js), which mirrors public.fsnv2_team_abbr() and
 * the table in lib/services/normalize.ts. This module deliberately does not
 * keep a fourth copy.
 */
import { normalizeAbbr as teamAbbr } from './nflTeams.js';
/** Imagery is resolved in one place too — see js/playerAssets.js. */
import { espnIdFor, headshotUrlFor } from './playerAssets.js';

export { teamAbbr };

/* --------------------------------------------------------------- normalising */

/**
 * Mirrors public.fsnv2_player_key(). Punctuation and spacing differ between the
 * provider and the static pool ("Ja'Marr Chase" / "JaMarr Chase").
 * @param {string} name
 */
export function playerKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Provider position spellings -> the app's roster positions. */
const POSITION_ALIASES = { PK: 'K', DEF: 'DST', 'D/ST': 'DST', FB: 'RB' };

/** @param {string} position */
export function normalisePosition(position) {
  const raw = String(position || '').trim().toUpperCase();
  return POSITION_ALIASES[raw] || raw;
}

/**
 * The lookup key for a player. Defenses are keyed by team because the provider
 * and the pool name them differently; everyone else by name.
 * @param {{name: string, position: string, team: string}} row
 */
function matchKey(row) {
  const position = normalisePosition(row.position);
  if (position === 'DST') return `DST|${teamAbbr(row.team)}`;
  return `${position}|${playerKey(row.name)}`;
}

/* ------------------------------------------------------------------- pool -- */

/**
 * Builds the draft pool from fsnv2.players rows.
 *
 * The table holds both the browser's own seeded rows (`provider` null, carrying
 * adp and a season projection in `stats`) and the sync's roster rows (`adp` 999,
 * empty `stats`). Only rows with a real season projection can drive the VOR
 * maths — a pool padded with 536 zero-projection bench players would drag every
 * replacement level to zero and make every VOR meaningless. So the pool is built
 * from the projected rows, which by now carry the *synced* team: migration 0006
 * is what keeps Murray on MIN and Montgomery on HOU in those very rows.
 *
 * @param {Array<Object>} rows fsnv2_players output
 * @returns {import('./types.js').Player[]}
 */
export function buildLivePool(rows) {
  if (!Array.isArray(rows)) return [];

  /** @type {Map<string, Object>} */
  const best = new Map();
  const providerStatus = new Map();

  for (const row of rows) {
    if (!row?.provider) continue;
    const key = matchKey(row);
    const prior = providerStatus.get(key);
    if (!prior || String(row.synced_at || '') > String(prior.synced_at || '')) {
      providerStatus.set(key, row);
    }
  }

  for (const row of rows) {
    const projection = Number(row?.stats?.projection ?? 0);
    if (!Number.isFinite(projection) || projection <= 0) continue;

    const key = matchKey(row);
    const previous = best.get(key);
    // A duplicate can only happen if the pool was seeded twice; keep the
    // higher projection so the board never loses its best estimate.
    if (!previous || projection > Number(previous.stats?.projection ?? 0)) {
      best.set(key, row);
    }
  }

  return [...best.values()]
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      position: normalisePosition(row.position),
      team: teamAbbr(row.team),
      status: providerStatus.get(matchKey(row))?.status ?? row.status ?? null,
      injury: providerStatus.get(matchKey(row))?.injury ?? row.injury ?? null,
      injuryStatus: providerStatus.get(matchKey(row))?.injury_status ?? row.injury_status ?? null,
      newsStatus: providerStatus.get(matchKey(row))?.news_status ?? row.news_status ?? null,
      projection: Number(row.stats.projection),
      byeWeek: row.bye_week ?? null,
      // Imagery, carried explicitly: `headshot_url` and `espn_id` are what the
      // player audit wrote onto these very rows, and a Player that drops them
      // leaves the UI with nothing but a team badge to draw (js/playerAssets.js).
      headshotUrl: headshotUrlFor(row),
      espnId: espnIdFor(row),
      // enrichPlayers() recomputes all of these from `projection`.
      vor: 0,
      vorRank: 0,
      posRank: 0,
      tier: 1,
      sleeperAdp: row.stats?.sleeper_adp ?? null,
      searchRank: row.stats?.search_rank ?? null,
      adp: 999,
      draftedBy: null,
      pickNumber: null
    }))
    .sort((a, b) => b.projection - a.projection);
}

/* ------------------------------------------------------------ projections -- */

/**
 * week -> matchKey -> { points, opponent, team }
 * @param {Array<Object>} rows fsnv2_projections output
 */
export function buildProjectionIndex(rows) {
  /** @type {Map<number, Map<string, {points: number, opponent: string, team: string}>>} */
  const byWeek = new Map();
  if (!Array.isArray(rows)) return byWeek;

  for (const row of rows) {
    const week = Number(row?.week);
    const points = Number(row?.fantasy_points);
    if (!Number.isFinite(week) || !Number.isFinite(points)) continue;

    if (!byWeek.has(week)) byWeek.set(week, new Map());
    byWeek.get(week).set(matchKey(row), {
      points,
      opponent: teamAbbr(row.opponent),
      team: teamAbbr(row.team)
    });
  }
  return byWeek;
}

/* --------------------------------------------------------------- schedule -- */

/** '20260913_CHI@MIN' -> { away: 'CHI', home: 'MIN' } */
function teamsFromGameId(gameId) {
  const match = /_([A-Z]{2,4})@([A-Z]{2,4})$/.exec(String(gameId ?? '').toUpperCase());
  return match ? { away: teamAbbr(match[1]), home: teamAbbr(match[2]) } : { away: '', home: '' };
}

/** 'Week 3' / '3' / 3 -> 3, and NaN for anything else. */
function weekOf(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  return digits ? Number.parseInt(digits, 10) : Number.NaN;
}

/**
 * One game, from either shape we are handed: a `fsnv2_nfl_schedule` row
 * (`home_team` / `away_team` / `week`) or a raw Tank01 entry from
 * `/getNFLGamesForWeek` or `/getNFLGamesForDate` (`home` / `away` / `gameWeek`),
 * with `gameID` as the fallback for both since it names the two sides.
 */
function readGame(row) {
  if (!row || typeof row !== 'object') return null;

  const fromId = teamsFromGameId(row.external_id ?? row.gameID);
  const home = teamAbbr(row.home_team ?? row.home ?? row.homeTeam) || fromId.home;
  const away = teamAbbr(row.away_team ?? row.away ?? row.awayTeam) || fromId.away;
  const week = weekOf(row.week ?? row.gameWeek);

  if (!home || !away || home === away || !Number.isFinite(week)) return null;
  return { week, home, away };
}

/**
 * week -> abbr -> { opponent, home }
 *
 * Both sides of every game are written, so the matchup label is a lookup rather
 * than a scan: the home side reads 'vs AWAY', the away side '@ HOME'. A team
 * absent from a week that *is* in this map is on its bye — see
 * `opponentLabel()` in nflTeams.js.
 *
 * @param {Array<Object>} rows fsnv2_nfl_schedule output, or raw Tank01 games
 */
export function buildLiveSlate(rows) {
  /** @type {Map<number, Record<string, {opponent: string, home: boolean}>>} */
  const byWeek = new Map();
  if (!Array.isArray(rows)) return byWeek;

  for (const row of rows) {
    const game = readGame(row);
    if (!game) continue;

    if (!byWeek.has(game.week)) byWeek.set(game.week, {});
    const map = byWeek.get(game.week);
    map[game.home] = { opponent: game.away, home: true };
    map[game.away] = { opponent: game.home, home: false };
  }
  return byWeek;
}

/* ------------------------------------------------------------------ facade -- */

/**
 * @typedef {Object} LiveData
 * @property {import('./types.js').Player[]} pool
 * @property {Map<number, Record<string, {opponent: string, home: boolean}>>} slate
 * @property {(player: Object, week: number) => number|null} weeklyPoints
 * @property {number[]} projectionWeeks weeks the provider actually covers
 * @property {number[]} scheduleWeeks
 * @property {{players: number, projections: number, games: number}} counts
 */

/**
 * Assembles the three row sets into one object app.js can apply in a few lines.
 *
 * @param {{players?: Array<Object>, projections?: Array<Object>, schedule?: Array<Object>}} bundle
 * @returns {LiveData}
 */
export function createLiveData({ players = [], projections = [], schedule = [] } = {}) {
  const pool = buildLivePool(players);
  const projectionIndex = buildProjectionIndex(projections);
  const slate = buildLiveSlate(schedule);

  return {
    pool,
    slate,

    /**
     * Real projected points for a player in a week, or null when the provider
     * has not published that week — the caller then keeps its own estimate.
     */
    weeklyPoints(player, week) {
      if (!player) return null;
      const forWeek = projectionIndex.get(Number(week));
      if (!forWeek) return null;
      const hit = forWeek.get(matchKey(player));
      return hit ? hit.points : null;
    },

    projectionWeeks: [...projectionIndex.keys()].sort((a, b) => a - b),
    scheduleWeeks: [...slate.keys()].sort((a, b) => a - b),
    counts: {
      players: pool.length,
      projections: projections.length,
      games: schedule.length
    }
  };
}
