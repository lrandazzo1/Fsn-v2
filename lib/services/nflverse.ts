/**
 * nflverse.ts
 * -----------------------------------------------------------------------------
 * The reference dataset the player audit reconciles against: nflverse, the
 * community mirror of the league's own feeds. It is the same data `nflreadpy` /
 * `nflreadr` load, read straight from the release assets so this project needs
 * no Python and no R.
 *
 *   weekly_rosters/roster_weekly_<season>.csv   who is on which roster, by week
 *   rosters/roster_<season>.csv                 the season roster snapshot
 *   players/players.csv                         the cumulative id crosswalk
 *
 * Which of those answers "what team is this player on" matters, and is the whole
 * reason this file is not a one-liner:
 *
 *   - The weekly roster is the only source that is *current*. A player's team is
 *     taken from the highest week he appears in, preferring an active row, so a
 *     mid-season trade shows up the week it happens.
 *   - `players.csv` carries `latest_team`, which is a derived column and lags. It
 *     is read for the id crosswalk and as a last-resort team, never in
 *     preference to a roster row.
 *
 * Note on the URL: the players table is *not* at
 * `raw.githubusercontent.com/nflverse/nflverse-data/master/players/players.csv`
 * — that path 404s, because nflverse publishes its data as release assets rather
 * than committing them to the default branch. The release URLs below are what
 * `nflreadr` itself resolves to.
 *
 * Responses are cached on disk (`--cache-dir`, default the system temp dir) so a
 * re-run, a `--dry-run` and then the real write cost one download in total.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCsv } from './csv.ts';
import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';
import { normalizePlayerName, optionalNum, text } from './normalize.ts';
import { canonicalTeam, espnHeadshotUrl } from './teams.ts';

export const NFLVERSE_RELEASE_BASE = 'https://github.com/nflverse/nflverse-data/releases/download';

/** The statuses nflverse publishes, and what each one means for the audit. */
export const ROSTER_STATUS = {
  /** On the active roster — the rows a fantasy pool cares about. */
  ACT: 'active',
  /** Injured reserve, PUP, NFI: rostered, not playing. Team is still true. */
  RES: 'reserve',
  RSN: 'reserve',
  RSR: 'reserve',
  PUP: 'reserve',
  NFI: 'reserve',
  /** Practice squad. On the team, off the game-day roster. */
  DEV: 'practice_squad',
  EXE: 'exempt',
  SUS: 'suspended',
  INA: 'inactive',
  /** No longer with the team — a team code on these rows is where he *was*. */
  CUT: 'released',
  NWT: 'released',
  RET: 'retired'
} as const;

const OFF_ROSTER = new Set(['CUT', 'NWT', 'RET']);

/** A single player as nflverse describes him, in this project's vocabulary. */
export interface NflversePlayer {
  gsis_id: string | null;
  espn_id: string | null;
  sleeper_id: string | null;
  rotowire_id: string | null;
  yahoo_id: string | null;
  pfr_id: string | null;
  full_name: string;
  /** Canonical NFL position as published ('QB', 'OLB', 'FB', …). */
  position: string | null;
  /** Canonical franchise abbreviation, or null when he is on no roster. */
  team: string | null;
  jersey: string | null;
  status: string | null;
  /** True while he is on a roster (active, injured, practice squad). */
  rostered: boolean;
  headshot_url: string | null;
  college: string | null;
  years_exp: number | null;
  birth_date: string | null;
  /** Which file this row's team came from, for the audit log. */
  team_source: 'weekly_roster' | 'season_roster' | 'players_latest_team';
  season: number | null;
  week: number | null;
}

export interface NflverseFetchOptions {
  season: number;
  /** Override the release base (a mirror, or a fixture directory served over HTTP). */
  baseUrl?: string;
  cacheDir?: string | null;
  /** Re-download even when a cached copy exists. */
  refresh?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  logger?: Logger;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Prefer the ESPN combiner headshot over nflverse's own `headshot_url`. */
  preferEspnHeadshots?: boolean;
}

export interface NflverseDataset {
  season: number;
  players: NflversePlayer[];
  /** Which files were actually read, and how many rows each contributed. */
  sources: Array<{ url: string; rows: number; cached: boolean }>;
  warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;

function cachePath(dir: string, url: string): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 12);
  const name = url.split('/').pop() ?? 'download';
  return join(dir, `nflverse-${hash}-${name}`);
}

/**
 * Downloads a CSV, with a disk cache and retries on 5xx/network failures.
 * Returns null on 404 — a season's file may simply not exist yet, which the
 * caller handles by falling back a season rather than failing.
 */
async function fetchCsv(
  url: string,
  options: NflverseFetchOptions
): Promise<{ rows: Array<Record<string, string>>; cached: boolean } | null> {
  const logger = options.logger ?? silentLogger;
  const doFetch = options.fetch ?? (globalThis.fetch as NflverseFetchOptions['fetch']);
  const cacheDir = options.cacheDir === null ? null : options.cacheDir ?? join(tmpdir(), 'fsnv2-nflverse');
  const file = cacheDir ? cachePath(cacheDir, url) : null;

  if (file && !options.refresh) {
    const cached = await readFile(file, 'utf8').catch(() => null);
    if (cached !== null) {
      const age = await stat(file)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0);
      logger.debug('nflverse cache hit', { url, age_ms: age });
      return { rows: parseCsv(cached), cached: true };
    }
  }

  if (!doFetch) throw new Error('No fetch implementation available to reach nflverse.');

  const maxRetries = Math.max(0, options.maxRetries ?? 3);
  const retryBaseMs = Math.max(0, options.retryBaseMs ?? 750);
  let attempt = 0;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      logger.debug('nflverse fetch', { url, attempt: attempt + 1 });
      const response = await doFetch(url, {
        redirect: 'follow',
        headers: { accept: 'text/csv,*/*', 'user-agent': 'fsn-v2-player-audit' },
        signal: controller.signal
      });

      if (response.status === 404) {
        logger.debug('nflverse 404', { url });
        return null;
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxRetries) {
          const delay = retryBaseMs * 2 ** attempt;
          logger.warn('nflverse fetch failed, retrying', { url, status: response.status, delay_ms: delay });
          attempt += 1;
          await new Promise<void>((done) => setTimeout(done, delay));
          continue;
        }
        throw new Error(`nflverse fetch failed: ${response.status} ${response.statusText} for ${url}`);
      }

      const body = await response.text();
      if (file) {
        await mkdir(cacheDir as string, { recursive: true }).catch(() => undefined);
        await writeFile(file, body, 'utf8').catch((error: Error) => {
          logger.warn('could not cache the nflverse download', { url, error: error.message });
        });
      }
      return { rows: parseCsv(body), cached: false };
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      if (attempt >= maxRetries) {
        throw aborted ? new Error(`nflverse fetch timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms: ${url}`) : error;
      }
      const delay = retryBaseMs * 2 ** attempt;
      logger.warn('nflverse fetch errored, retrying', {
        url,
        attempt: attempt + 1,
        delay_ms: delay,
        error: (error as Error).message
      });
      attempt += 1;
      await new Promise<void>((done) => setTimeout(done, delay));
    } finally {
      clearTimeout(timer);
    }
  }
}

const cell = (row: Record<string, string>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = text(row[key]);
    if (value !== null && value !== 'NA') return value;
  }
  return null;
};

/** nflverse writes ids as numbers, so '3917315.0' shows up. Trim the tail. */
const idCell = (row: Record<string, string>, ...keys: string[]): string | null => {
  const value = cell(row, ...keys);
  if (value === null) return null;
  const trimmed = value.replace(/\.0+$/, '');
  return trimmed === '' ? null : trimmed;
};

function headshotOf(row: Record<string, string>, espnId: string | null, preferEspn: boolean): string | null {
  const published = cell(row, 'headshot_url', 'headshot');
  const espn = espnHeadshotUrl(espnId);
  if (preferEspn) return espn ?? published;
  return published ?? espn;
}

function rosterRowToPlayer(
  row: Record<string, string>,
  source: NflversePlayer['team_source'],
  preferEspn: boolean
): NflversePlayer | null {
  const name = cell(row, 'full_name', 'display_name', 'player_name', 'football_name');
  if (!name) return null;

  const espnId = idCell(row, 'espn_id');
  const status = cell(row, 'status');
  const team = canonicalTeam(cell(row, 'team', 'latest_team', 'recent_team'));

  return {
    gsis_id: idCell(row, 'gsis_id', 'player_id'),
    espn_id: espnId,
    sleeper_id: idCell(row, 'sleeper_id'),
    rotowire_id: idCell(row, 'rotowire_id'),
    yahoo_id: idCell(row, 'yahoo_id'),
    pfr_id: idCell(row, 'pfr_id'),
    full_name: name,
    position: cell(row, 'position', 'depth_chart_position', 'ngs_position'),
    team,
    jersey: idCell(row, 'jersey_number'),
    status,
    rostered: status === null ? team !== null : !OFF_ROSTER.has(status.toUpperCase()),
    headshot_url: headshotOf(row, espnId, preferEspn),
    college: cell(row, 'college', 'college_name'),
    years_exp: optionalNum(row.years_exp ?? row.years_of_experience),
    birth_date: cell(row, 'birth_date'),
    team_source: source,
    season: optionalNum(row.season),
    week: optionalNum(row.week)
  };
}

/** The identity of a row across files: gsis id if there is one, else name. */
const identityOf = (player: NflversePlayer): string =>
  player.gsis_id ?? player.espn_id ?? `name:${normalizePlayerName(player.full_name)}`;

/**
 * Which of two rows for the same player describes his team *now*: the later
 * week wins, then an on-roster row over a released one, then the weekly file
 * over the season snapshot over `latest_team`.
 */
const SOURCE_RANK: Record<NflversePlayer['team_source'], number> = {
  weekly_roster: 3,
  season_roster: 2,
  players_latest_team: 1
};

function fresher(candidate: NflversePlayer, incumbent: NflversePlayer): boolean {
  const byWeek = (candidate.week ?? -1) - (incumbent.week ?? -1);
  if (byWeek !== 0) return byWeek > 0;
  if (candidate.rostered !== incumbent.rostered) return candidate.rostered;
  return SOURCE_RANK[candidate.team_source] > SOURCE_RANK[incumbent.team_source];
}

/** Fills the gaps in `into` from `from` without touching what is already there. */
function mergeInto(into: NflversePlayer, from: NflversePlayer): void {
  const keys: Array<keyof NflversePlayer> = [
    'gsis_id',
    'espn_id',
    'sleeper_id',
    'rotowire_id',
    'yahoo_id',
    'pfr_id',
    'position',
    'jersey',
    'headshot_url',
    'college',
    'years_exp',
    'birth_date'
  ];
  for (const key of keys) {
    if (into[key] === null || into[key] === undefined) {
      (into as unknown as Record<string, unknown>)[key] = from[key];
    }
  }
}

/**
 * Loads the reference dataset for a season: the weekly rosters for the current
 * team, the season roster to cover anyone the weekly file misses, and the
 * cumulative players table for the id crosswalk and headshot fallback.
 *
 * A season whose roster files are not published yet falls back one season, which
 * is what makes this safe to run in the gap between February and the draft.
 */
export async function fetchNflversePlayers(options: NflverseFetchOptions): Promise<NflverseDataset> {
  const logger = options.logger ?? silentLogger;
  const base = (options.baseUrl ?? NFLVERSE_RELEASE_BASE).replace(/\/+$/, '');
  const preferEspn = options.preferEspnHeadshots ?? true;
  const sources: NflverseDataset['sources'] = [];
  const warnings: string[] = [];
  const byIdentity = new Map<string, NflversePlayer>();

  const absorb = (rows: Array<Record<string, string>>, source: NflversePlayer['team_source']): number => {
    let used = 0;
    for (const row of rows) {
      const player = rosterRowToPlayer(row, source, preferEspn);
      if (!player) continue;
      used += 1;
      const key = identityOf(player);
      const incumbent = byIdentity.get(key);
      if (!incumbent) {
        byIdentity.set(key, player);
        continue;
      }
      if (fresher(player, incumbent)) {
        mergeInto(player, incumbent);
        byIdentity.set(key, player);
      } else {
        mergeInto(incumbent, player);
      }
    }
    return used;
  };

  // 1. Weekly rosters — the only current view of who is on which team.
  let rosterSeason = options.season;
  let weekly = await fetchCsv(`${base}/weekly_rosters/roster_weekly_${rosterSeason}.csv`, options);
  if (!weekly) {
    warnings.push(`no weekly roster file for ${rosterSeason}; falling back to ${rosterSeason - 1}`);
    rosterSeason -= 1;
    weekly = await fetchCsv(`${base}/weekly_rosters/roster_weekly_${rosterSeason}.csv`, options);
  }
  if (weekly) {
    const used = absorb(weekly.rows, 'weekly_roster');
    sources.push({
      url: `${base}/weekly_rosters/roster_weekly_${rosterSeason}.csv`,
      rows: used,
      cached: weekly.cached
    });
  } else {
    warnings.push('no weekly roster file available — team assignments come from the season snapshot');
  }

  // 2. Season roster snapshot — anyone the weekly file has not listed yet.
  const seasonRoster = await fetchCsv(`${base}/rosters/roster_${rosterSeason}.csv`, options);
  if (seasonRoster) {
    const used = absorb(seasonRoster.rows, 'season_roster');
    sources.push({ url: `${base}/rosters/roster_${rosterSeason}.csv`, rows: used, cached: seasonRoster.cached });
  } else {
    warnings.push(`no season roster file for ${rosterSeason}`);
  }

  // 3. The cumulative players table — the id crosswalk, and a headshot for
  //    anyone the roster files have no portrait for.
  const players = await fetchCsv(`${base}/players/players.csv`, options);
  if (players) {
    const used = absorb(players.rows, 'players_latest_team');
    sources.push({ url: `${base}/players/players.csv`, rows: used, cached: players.cached });
  } else {
    warnings.push('players.csv is unavailable — id crosswalk limited to the roster files');
  }

  if (byIdentity.size === 0) {
    throw new Error(
      'nflverse returned no players. Check network access to github.com, or point --base-url at a mirror.'
    );
  }

  logger.info('nflverse reference loaded', {
    season: rosterSeason,
    players: byIdentity.size,
    files: sources.length
  });

  return { season: rosterSeason, players: [...byIdentity.values()], sources, warnings };
}
