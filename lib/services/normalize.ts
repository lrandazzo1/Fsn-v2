/**
 * normalize.ts
 * -----------------------------------------------------------------------------
 * Small, boring coercions that every provider needs. Vendor feeds ship numbers
 * as strings, positions under half a dozen spellings and kickoff times in
 * whatever their CMS happened to store, so all of that gets flattened here
 * rather than inside each mapper.
 */

import { canonicalTeam } from './teams.ts';
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
 * Team abbreviations are stored as one of the 32 canonical codes in teams.ts —
 * 'ARZ' and 'WSH' become ARI and WAS, nflverse's 'LA' becomes LAR — and free
 * agents are 'FA'.
 *
 * It used to just uppercase whatever it was handed, which is how a provider's
 * numeric team id (`teamID: 21`) became the team "21" and how the same franchise
 * ended up stored under two spellings. A value that resolves to no franchise now
 * falls back instead of being stored verbatim; `canonicalTeam()` is the variant
 * that reports "unknown" rather than defaulting.
 */
export function teamAbbr(value: unknown, fallback = 'FA'): string {
  return canonicalTeam(value) ?? (fallback === 'FA' ? 'FA' : canonicalTeam(fallback) ?? 'FA');
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
 * Suffix stripping is what the first reconciliation pass was missing: 42 of the
 * 208 hand-maintained rows failed to match the roster feed purely on 'Sr.',
 * which left their team assignments frozen at whatever they were seeded with.
 */
export function normalizePlayerName(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  const words = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
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

const GAME_STATUS_ALIASES: Array<[RegExp, GameStatus]> = [
  [/^(completed|final|closed|f\/ot)/i, 'final'],
  [/(live|in\s*progress|progress|halftime|q[1-4])/i, 'in_progress'],
  [/postponed|suspended|delayed/i, 'postponed'],
  [/cancel/i, 'canceled'],
  [/scheduled|not\s*started|pre[-\s]?game/i, 'scheduled']
];

export function gameStatus(value: unknown, fallback: GameStatus = 'scheduled'): GameStatus {
  const raw = text(value);
  if (!raw) return fallback;
  for (const [pattern, status] of GAME_STATUS_ALIASES) {
    if (pattern.test(raw)) return status;
  }
  return fallback;
}

/**
 * Kickoff to ISO-8601 UTC, from whichever of these the feed gave us:
 *   epoch seconds ("1759683600" / 1759683600.0)
 *   an ISO string
 *   Tank01's split fields: gameDate "20251005" + gameTime "1:00p" (US Eastern)
 */
export function kickoffIso(input: {
  epoch?: unknown;
  iso?: unknown;
  date?: unknown;
  time?: unknown;
}): string | null {
  const epoch = optionalNum(input.epoch);
  if (epoch && epoch > 1_000_000_000 && epoch < 10_000_000_000) {
    return new Date(Math.round(epoch * 1000)).toISOString();
  }

  const iso = text(input.iso);
  if (iso) {
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const date = text(input.date);
  if (!date) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
  const dashed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const parts = compact ?? dashed;
  if (!parts) return null;

  const [, year, month, day] = parts;
  let hour = 13;
  let minute = 0;
  const time = text(input.time);
  const clock = time ? /^(\d{1,2}):(\d{2})\s*([ap])?/i.exec(time) : null;
  if (clock) {
    hour = Number.parseInt(clock[1], 10);
    minute = Number.parseInt(clock[2], 10);
    const meridiem = clock[3]?.toLowerCase();
    if (meridiem === 'p' && hour < 12) hour += 12;
    if (meridiem === 'a' && hour === 12) hour = 0;
  }

  // Feeds quote kickoff in US Eastern. EDT (-4) runs through the first week of
  // November, EST (-5) after it — close enough for a kickoff timestamp, and the
  // epoch field above is preferred whenever the provider sends one.
  const monthNum = Number.parseInt(month, 10);
  const dayNum = Number.parseInt(day, 10);
  const easternOffset = monthNum > 11 || monthNum < 3 || (monthNum === 11 && dayNum > 7) ? 5 : 4;
  const utc = Date.UTC(
    Number.parseInt(year, 10),
    monthNum - 1,
    dayNum,
    hour + easternOffset,
    minute
  );
  return new Date(utc).toISOString();
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
