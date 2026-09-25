/**
 * nflData.js
 * -----------------------------------------------------------------------------
 * The live Tank01 layer, as the browser sees it.
 *
 * The ingestion service (lib/services/*) pulls Tank01 and lands it in Postgres;
 * this module reads it back out through the public RPCs and turns it into the
 * two things the UI actually needs:
 *
 *   fsnv2_nfl_teams()     -> the `/getNFLTeams` dictionary: teamID -> teamAbv,
 *                            logos and bye weeks
 *   fsnv2_nfl_schedule()  -> the `/getNFLGamesForWeek` slate, which drives every
 *                            "vs CLE" / "@ PIT" / "BYE" label
 *   fsnv2_players()       -> the synced rosters, which decide what team a player
 *                            is actually on
 *
 * The rule this module exists to enforce: a player's team and a player's
 * matchup come from the provider payload, never from the seed pool in
 * playerData.js and never from a locally generated schedule. js/playerData.js
 * stays as the offline seed for projections and draft order only; the moment
 * synced rosters are available, `applyTeams()` overwrites every team code with
 * the provider's own `teamAbv`.
 */

import {
  annotatePlayers,
  applyNflTeamMeta,
  normalizeTeamAbbr,
  setNflSchedule,
  teamIdIndex
} from './nflTeams.js';

/* ------------------------------------------------------------ season / week */

/**
 * The NFL season a date belongs to: the 2026 season runs Sep 2026 -> Feb 2027,
 * so anything before March still belongs to the previous season's year.
 * Mirrors `currentSeason()` in lib/services/env.ts — keep the two in step.
 */
export function currentSeason(now = new Date()) {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 2 ? year : year - 1;
}

/** Week 1 kicks off the Thursday after Labor Day (the first Monday of September). */
export function seasonKickoff(season) {
  const september = new Date(Date.UTC(season, 8, 1));
  const firstMonday = 1 + ((8 - september.getUTCDay()) % 7);
  return new Date(Date.UTC(season, 8, firstMonday + 3));
}

/**
 * The week a date falls in, counting Thursday-to-Wednesday from kickoff.
 * Before the season opens it reads as week 1; after week 18 it stays at 18.
 * Mirrors `currentNflWeek()` in lib/services/env.ts.
 */
export function currentNflWeek(now = new Date(), season = currentSeason(now)) {
  const kickoff = seasonKickoff(season);
  const days = Math.floor((now.getTime() - kickoff.getTime()) / 86400000);
  if (days < 0) return 1;
  return Math.min(18, Math.floor(days / 7) + 1);
}

/* ------------------------------------------------------------ name matching */

const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

/**
 * A join key for two spellings of the same player. Tank01's `longName` carries
 * suffixes and punctuation our pool does not ("Deebo Samuel Sr." against
 * "Deebo Samuel", "Ja'Marr Chase" against "JaMarr Chase"), so both sides are
 * folded to letters and spaces with the generational suffix dropped.
 */
export function playerKey(name) {
  const cleaned = String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const parts = cleaned.split(' ');
  while (parts.length > 2 && NAME_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}

/** Builds name -> row and name|POS -> row indexes over the synced roster rows. */
function indexLivePlayers(rows) {
  const byName = new Map();
  const byNamePos = new Map();

  for (const row of rows) {
    const key = playerKey(row?.name);
    if (!key) continue;
    const position = String(row.position ?? '').toUpperCase();

    // A name that appears twice is ambiguous — record it, then refuse to use it.
    byName.set(key, byName.has(key) ? null : row);
    if (position) {
      const posKey = `${key}|${position}`;
      byNamePos.set(posKey, byNamePos.has(posKey) ? null : row);
    }
  }
  return { byName, byNamePos };
}

/* ------------------------------------------------------------------ loading */

/**
 * Reads the synced Tank01 payloads back out of Supabase.
 *
 * Every call is best-effort: a missing table, a disabled Supabase or an
 * unreachable network leaves that slice empty rather than throwing, because a
 * draft board with stale team codes is still better than no draft board. What
 * it never does is substitute invented data for a failed call.
 */
export class NflDataService {
  /**
   * @param {Object} options
   * @param {import('./persistence.js').DraftRepository} options.repo
   * @param {number} [options.season] defaults to the season the current date falls in
   * @param {number} [options.week]   defaults to the week the current date falls in
   * @param {(event: Object) => void} [options.onStatus]
   */
  constructor({ repo, season, week, onStatus } = {}) {
    this.repo = repo;
    this.season = season || currentSeason();
    this.week = week || currentNflWeek(new Date(), this.season);
    this.onStatus = onStatus || (() => {});

    /** @type {Array<Object>} */
    this.teams = [];
    /** @type {Array<Object>} */
    this.games = [];
    /** @type {Array<Object>} */
    this.players = [];
    /** @type {Map<string, string>} teamID -> teamAbv */
    this.teamIds = new Map();
    this.loaded = false;
    this.error = null;
  }

  get enabled() {
    return Boolean(this.repo?.enabled);
  }

  /**
   * Pulls teams, the full-season schedule and the synced rosters.
   * @returns {Promise<{teams: number, games: number, players: number, weeks: number[]}>}
   */
  async load() {
    if (!this.enabled) {
      this.onStatus({ status: 'offline' });
      return { teams: 0, games: 0, players: 0, weeks: [] };
    }

    this.onStatus({ status: 'loading' });
    const [teams, games, players] = await Promise.all([
      this.#read('nflTeams', () => this.repo.nflTeams()),
      // The whole season, not just one week, so every week the UI can select is real.
      this.#read('nflSchedule', () => this.repo.nflSchedule(this.season, null)),
      this.#read('players', () => this.repo.players(4000))
    ]);

    this.teams = teams;
    this.games = games;
    // Only provider-synced rows carry a real team assignment; the seed rows
    // pushed up by syncPlayers() are the very thing we are correcting.
    this.players = players.filter((row) => row?.provider);
    this.teamIds = teamIdIndex(this.teams);

    applyNflTeamMeta(this.teams);
    const { weeks } = setNflSchedule(this.games);

    this.loaded = true;
    const summary = {
      teams: this.teams.length,
      games: this.games.length,
      players: this.players.length,
      weeks
    };
    this.onStatus({ status: 'ready', ...summary, season: this.season, week: this.week });
    return summary;
  }

  /**
   * One read, best-effort. A slice that fails comes back empty and is reported;
   * it is never replaced with generated data.
   */
  async #read(label, call) {
    try {
      const rows = await call();
      return Array.isArray(rows) ? rows : [];
    } catch (error) {
      this.error = error;
      this.onStatus({ status: 'error', source: label, error: error.message });
      return [];
    }
  }

  /**
   * The abbreviation a synced row belongs to, preferring what Tank01 sends:
   * the `team` / `teamAbv` string, and only then the `teamID` resolved through
   * the `/getNFLTeams` dictionary.
   */
  teamAbbrOf(row) {
    const direct = normalizeTeamAbbr(row?.team ?? row?.teamAbv);
    if (direct) return direct;
    const id = row?.nfl_team_external_id ?? row?.teamID;
    return id === undefined || id === null ? null : this.teamIds.get(String(id)) ?? null;
  }

  /**
   * Rewrites every pool player's team from the synced rosters.
   *
   * This is the fix for "Deebo Samuel shows WAS": the seed pool in
   * playerData.js is a snapshot that ages the moment a player is traded, so
   * whatever the provider says wins, unconditionally, for every player it knows.
   *
   * @param {Record<string, import('./types.js').Player>} playersById
   * @returns {{matched: number, corrected: number, unmatched: string[]}}
   */
  applyTeams(playersById) {
    const pool = Object.values(playersById ?? {});
    if (this.players.length === 0) {
      return { matched: 0, corrected: 0, unmatched: pool.map((player) => player.name) };
    }

    const { byName, byNamePos } = indexLivePlayers(this.players);
    let matched = 0;
    let corrected = 0;
    const unmatched = [];

    for (const player of pool) {
      // A team defense *is* its franchise — there is nothing to look up.
      if (player.position === 'DST') {
        player.team = normalizeTeamAbbr(player.team) ?? player.team;
        continue;
      }

      const key = playerKey(player.name);
      const row = byNamePos.get(`${key}|${player.position}`) ?? byName.get(key) ?? null;
      if (!row) {
        unmatched.push(player.name);
        continue;
      }

      matched += 1;
      player.externalId = row.external_id ?? null;
      player.status = row.status ?? player.status ?? null;
      player.injury = row.injury ?? null;
      if (Number.isInteger(row.bye_week)) player.byeWeek = row.bye_week;

      const team = this.teamAbbrOf(row);
      if (!team) {
        // The provider has the player but not on a roster — a free agent.
        player.freeAgent = true;
        continue;
      }
      player.freeAgent = false;
      if (player.team !== team) {
        player.team = team;
        corrected += 1;
      }
    }

    return { matched, corrected, unmatched };
  }

  /**
   * Stamps the week's matchup onto every player, so a lineup or bench component
   * can render `{player.team}` and `{player.opponent}` straight from the payload
   * instead of reaching for a schedule of its own.
   *
   * @param {Record<string, import('./types.js').Player>} playersById
   * @param {number} week
   */
  annotate(playersById, week = this.week) {
    return annotatePlayers(playersById, week);
  }
}

/** Convenience wrapper: load, correct every team, stamp the active week. */
export async function hydrateNflContext({ repo, playersById, season, week, onStatus }) {
  const service = new NflDataService({ repo, season, week, onStatus });
  const summary = await service.load();
  const teams = service.applyTeams(playersById);
  service.annotate(playersById, service.week);
  return { service, summary, teams };
}
