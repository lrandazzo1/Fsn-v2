/**
 * normalize.ts
 * -----------------------------------------------------------------------------
 * Small, boring coercions that every provider needs. Vendor feeds ship numbers
 * as strings, positions under half a dozen spellings and kickoff times in
 * whatever their CMS happened to store, so all of that gets flattened here
 * rather than inside each mapper.
 */

import { CANONICAL_TEAMS, canonicalTeam } from './teams.ts';
import { normalizeGameStatus, parseKickoff } from '../../js/gameLock.js';
import type { FantasyPosition, GameStatus, StatLine } from './types.ts';

/** Tank01 (and most RapidAPI feeds) send every stat as a string. */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return fallback;
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

export function optionalNum(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = num(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

export function text(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

const POSITION_ALIASES: Record<string, FantasyPosition> = {
  QB: 'QB',
  RB: 'RB',
  FB: 'RB',
  'RB/WR': 'RB',
  HB: 'RB',
  WR: 'WR',
  'WR/RB': 'WR',
  TE: 'TE',
  K: 'K',
  PK: 'K',
  DST: 'DST',
  DEF: 'DST',
  'D/ST': 'DST',
  DEFENSE: 'DST'
};

/** Returns null for positions the fantasy pool does not carry (OL, LB, CB…). */
export function fantasyPosition(value: unknown): FantasyPosition | null {
  const raw = text(value);
  if (!raw) return null;
  return POSITION_ALIASES[raw.toUpperCase()] ?? null;
}

/**
 * Franchise abbreviations, canonicalised to the set the app renders with
 * (js/nflTeams.js — the same 32 keys the logo chip, the team colours and the
 * synthetic NFL slate are keyed on).
 *
 * Vendors disagree on a handful of them — Tank01 sends Washington as `WSH`,
 * other feeds send `JAC` for Jacksonville or still carry a relocated team's old
 * city — and an abbreviation the UI does not know renders as a grey chip with
 * no logo and no opponent. Relocations collapse onto the current franchise:
 * `OAK`/`SD`/`STL` are the same clubs as `LV`/`LAC`/`LAR`.
 *
 * The alias table itself now lives in ./teams.ts, which is the one place it is
 * maintained: this module, the player audit and `fsnv2.canonical_team()` in
 * migration 0007 all read from the same list, so a code added for one of them is
 * added for all three. teams.ts also refuses anything numeric, which is what
 * keeps a provider's internal team id out of a column that holds franchises.
 */

/** The 32 franchise codes everything downstream is keyed by. */
export const NFL_TEAM_ABBRS = new Set(CANONICAL_TEAMS);

/** Team abbreviations are compared and stored uppercase; free agents are 'FA'. */
export function teamAbbr(value: unknown, fallback = 'FA'): string {
  return canonicalTeam(value) ?? canonicalTeam(fallback) ?? fallback;
}

/**
 * The same, but null for anything that is not one of the 32 franchises.
 *
 * Used wherever a value has to be a *team* and not merely a string: a game's
 * two sides, a projection's `team`, a roster entry's affiliation. Writing an
 * unrecognised code through means the row no longer joins to its game in
 * fsnv2.nfl_matchups, and the player renders someone else's opponent.
 */
export function knownTeamAbbr(value: unknown): string | null {
  return canonicalTeam(value);
}

/** Suffixes that a feed appends to a surname and another feed leaves off. */
const NAME_SUFFIXES = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);

/**
 * A player's name reduced to what two feeds can be expected to agree on:
 * lowercase letters only, accents folded, punctuation and generational suffixes
 * dropped.
 *
 *   'Deebo Samuel Sr.'  -> 'deebosamuel'
 *   "Ja'Marr Chase"     -> 'jamarrchase'
 *   'A.J. Brown'        -> 'ajbrown'
 *   'Kenneth Walker III'-> 'kennethwalker'
 *
 * Suffix stripping is the part `fsnv2_player_match_key()` (migration 0006) does
 * not do, and it is what the first reconciliation pass was missing: 42 of the
 * 208 hand-maintained rows failed to match the roster feed purely on 'Sr.',
 * which left their team assignments frozen at whatever they were seeded with.
 */
export function normalizePlayerName(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  const words = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && NAME_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join('').toLowerCase();
}

/**
 * The key a name+position match is made on. Position is part of it because two
 * players do share a name (there are two Josh Allens), and a name collision
 * across positions is the one case where a name-only match would be wrong.
 */
export function playerMatchKey(name: unknown, position: unknown): string {
  const normalized = normalizePlayerName(name);
  if (!normalized) return '';
  const pos = fantasyPosition(position) ?? text(position)?.toUpperCase() ?? '';
  return `${normalized}|${pos}`;
}

/**
 * A vendor's status string reduced to one of the five `fsnv2.nfl_matchups`
 * allows. The alias table lives in js/gameLock.js, because the lineup lock turns
 * on the same words ("Final", "In Progress") and a second copy here would be a
 * copy that drifts.
 */
export function gameStatus(value: unknown, fallback: GameStatus = 'scheduled'): GameStatus {
  return (normalizeGameStatus(value) as GameStatus | null) ?? fallback;
}

/**
 * Kickoff to ISO-8601 UTC, from whichever of these the feed gave us:
 *   epoch seconds ("1759683600" / 1759683600.0) or millis
 *   an ISO string
 *   Tank01's split fields: gameDate "20251005" + gameTime "1:00p" (US Eastern)
 *
 * The parsing itself is `parseKickoff()` in js/gameLock.js — the lineup lock
 * compares `now` against exactly this instant, so the two must never be able to
 * read a feed differently.
 */
export function kickoffIso(input: {
  epoch?: unknown;
  iso?: unknown;
  date?: unknown;
  time?: unknown;
}): string | null {
  const ms = parseKickoff(input);
  return ms === null ? null : new Date(ms).toISOString();
}

/** The same kickoff as epoch millis — what `isPlayerLocked()` compares against. */
export function kickoffEpoch(input: {
  epoch?: unknown;
  iso?: unknown;
  date?: unknown;
  time?: unknown;
}): number | null {
  return parseKickoff(input);
}

export interface FlattenOptions {
  /** Top-level keys to leave out — identity fields, not statistics. */
  exclude?: Set<string>;
}

/**
 * Flattens a provider's nested stat groups into one prefixed, numeric map:
 *   { Passing: { passYds: "268" } } -> { "passing.passYds": 268 }
 *
 * Non-numeric leaves are dropped, and so are the excluded top-level keys —
 * without them a numeric-looking `playerID` or `teamID` would land in `stats` and
 * read like a statistic. `stats` is for arithmetic; `raw` keeps the original
 * payload for everything else.
 */
export function flattenStats(
  input: unknown,
  prefix = '',
  options: FlattenOptions = {}
): StatLine {
  const out: StatLine = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!prefix && options.exclude?.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenStats(value, path.toLowerCase(), options));
      continue;
    }
    const parsed = optionalNum(value);
    if (parsed !== null) out[path] = parsed;
  }
  return out;
}

/** Asserts a week number the database will accept (0 = preseason placeholder). */
export function assertWeek(week: unknown, label = 'week'): number {
  const parsed = optionalNum(week);
  if (parsed === null || !Number.isInteger(parsed) || parsed < 1 || parsed > 22) {
    throw new TypeError(`${label} must be an integer between 1 and 22, got ${String(week)}`);
  }
  return parsed;
}

export function chunk<T>(rows: T[], size: number): T[][] {
  if (size <= 0) throw new TypeError(`chunk size must be positive, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
