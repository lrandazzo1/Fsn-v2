/**
 * nflTeams.js
 * -----------------------------------------------------------------------------
 * NFL franchise metadata for the scoreboard: primary colours, logo URLs and a
 * weekly opponent for every team.
 *
 * Logos come from a CDN, and — like the Tailwind/Lucide layers in index.html —
 * the UI has to survive that CDN being blocked. `teamLogoHtml()` renders the
 * abbreviation in the team's colour *behind* the image, so a failed load falls
 * back to a coloured chip instead of a broken-image icon.
 *
 * Opponents come from the real NFL slate whenever the sports-data sync has it:
 * app.js reads `fsnv2_nfl_schedule` on boot and installs the result through
 * `setLiveSlate()`. Any week the sync has not stored falls back to a synthetic
 * 32-team round robin drawn by the same seeded shuffle the league schedule
 * uses — stable across reloads, an opponent for every team every week, and only
 * ever used as display context next to a player's name ("@ MIA", "vs NYJ").
 *
 * `hasLiveSlate(week)` says which of the two a given week is being served by,
 * so the UI can label a synthetic opponent honestly rather than passing it off
 * as a real fixture.
 */

import { lcgShuffle, roundRobinRounds } from './seasonEngine.js';

/**
 * abbr -> { name, color, slug }
 * `slug` is the CDN's identifier where it differs from our abbreviation.
 */
export const NFL_TEAMS = {
  ARI: { name: 'Cardinals', color: '#97233f' },
  ATL: { name: 'Falcons', color: '#a71930' },
  BAL: { name: 'Ravens', color: '#241773' },
  BUF: { name: 'Bills', color: '#00338d' },
  CAR: { name: 'Panthers', color: '#0085ca' },
  CHI: { name: 'Bears', color: '#0b162a' },
  CIN: { name: 'Bengals', color: '#fb4f14' },
  CLE: { name: 'Browns', color: '#ff3c00' },
  DAL: { name: 'Cowboys', color: '#041e42' },
  DEN: { name: 'Broncos', color: '#fb4f14' },
  DET: { name: 'Lions', color: '#0076b6' },
  GB: { name: 'Packers', color: '#203731' },
  HOU: { name: 'Texans', color: '#03202f' },
  IND: { name: 'Colts', color: '#002c5f' },
  JAX: { name: 'Jaguars', color: '#006778' },
  KC: { name: 'Chiefs', color: '#e31837' },
  LAC: { name: 'Chargers', color: '#0080c6' },
  LAR: { name: 'Rams', color: '#003594' },
  LV: { name: 'Raiders', color: '#0f0f0f' },
  MIA: { name: 'Dolphins', color: '#008e97' },
  MIN: { name: 'Vikings', color: '#4f2683' },
  NE: { name: 'Patriots', color: '#002244' },
  NO: { name: 'Saints', color: '#9f8958' },
  NYG: { name: 'Giants', color: '#0b2265' },
  NYJ: { name: 'Jets', color: '#125740' },
  PHI: { name: 'Eagles', color: '#004c54' },
  PIT: { name: 'Steelers', color: '#ffb612' },
  SEA: { name: 'Seahawks', color: '#002244' },
  SF: { name: '49ers', color: '#aa0000' },
  TB: { name: 'Buccaneers', color: '#d50a0a' },
  TEN: { name: 'Titans', color: '#0c2340' },
  WAS: { name: 'Commanders', color: '#5a1414', slug: 'wsh' }
};

/** Stable alphabetical order so the generated schedule never shifts. */
export const NFL_ABBRS = Object.keys(NFL_TEAMS).sort();

/**
 * abbr as a feed spells it -> abbr as this module keys it.
 *
 * A player's `team` now comes from the roster sync rather than the static pool,
 * and vendors do not agree on every abbreviation: Tank01 sends Washington as
 * `WSH`, other feeds send `JAC` for Jacksonville, and a relocated club is still
 * `OAK`/`SD`/`STL` here and there. An abbreviation this table does not resolve
 * renders as a grey chip with no logo and no opponent, so it is applied on
 * every lookup below. Mirrors `TEAM_ALIASES` in lib/services/normalize.ts,
 * which canonicalises the same abbreviations on the way into the database.
 */
export const TEAM_ALIASES = {
  ARZ: 'ARI',
  BLT: 'BAL',
  CLV: 'CLE',
  GNB: 'GB',
  HST: 'HOU',
  JAC: 'JAX',
  JAG: 'JAX',
  KAN: 'KC',
  LA: 'LAR',
  LVR: 'LV',
  NOR: 'NO',
  NWE: 'NE',
  OAK: 'LV',
  SD: 'LAC',
  SDG: 'LAC',
  SFO: 'SF',
  STL: 'LAR',
  TAM: 'TB',
  WFT: 'WAS',
  WSH: 'WAS'
};

/**
 * The canonical abbreviation for whatever a row carries — '' for a missing or
 * unrecognisable value, so callers can fall back instead of rendering junk.
 * @param {string|null|undefined} abbr
 * @returns {string}
 */
export function normalizeAbbr(abbr) {
  const raw = String(abbr ?? '').trim().toUpperCase();
  if (!raw) return '';
  return TEAM_ALIASES[raw] || raw;
}

const LOGO_BASE = 'https://a.espncdn.com/i/teamlogos/nfl/500';

/** Seed for the synthetic NFL slate — independent of the league schedule seed. */
const NFL_SCHEDULE_SEED = 90210;

export function teamColor(abbr) {
  return NFL_TEAMS[normalizeAbbr(abbr)]?.color || '#475569';
}

export function teamName(abbr) {
  const key = normalizeAbbr(abbr);
  return NFL_TEAMS[key]?.name || key || '—';
}

/** CDN logo URL for a team abbreviation. */
export function teamLogoUrl(abbr) {
  const key = normalizeAbbr(abbr);
  const meta = NFL_TEAMS[key];
  if (!meta) return null;
  return `${LOGO_BASE}/${(meta.slug || key).toLowerCase()}.png`;
}

/**
 * The team badge: a logo on top of a coloured abbreviation chip, so a blocked
 * CDN degrades to the chip instead of a broken-image icon.
 *
 * Shared by the matchup board, the roster slots and the Team page so a player
 * who changed clubs shows his current badge everywhere the moment his `team`
 * changes — there is no per-view copy to keep in step.
 *
 * @param {string|null|undefined} abbr a player's current team abbreviation
 * @returns {string} HTML
 */
export function teamLogoHtml(abbr) {
  const key = normalizeAbbr(abbr).replace(/[^A-Z0-9]/g, '') || 'FA';
  const url = teamLogoUrl(key);
  return `
    <span class="team-logo" style="--team-color:${teamColor(key)}" title="${key}">
      <span class="team-logo__abbr">${key}</span>
      ${url ? `<img src="${url}" alt="" loading="lazy" onerror="this.remove()" />` : ''}
    </span>`;
}

/* --------------------------------------------------------- weekly opponents */

/**
 * week -> { [abbr]: { opponent, home } }
 * Built once on first use: 32 teams give 31 round-robin rounds, and the seeded
 * shuffle picks which of them become weeks 1-14.
 */
let slate = null;

/**
 * The real slate, once `fsnv2_nfl_schedule` has been read. Same shape as
 * `slate`, but only holds the weeks the sync has actually stored — a season
 * three weeks old has three. Weeks it does not cover fall through to the
 * synthetic round robin below, so the UI never shows a blank opponent.
 * @type {Map<number, Record<string, {opponent: string, home: boolean}>>|null}
 */
let liveSlate = null;

/**
 * Installs the synced NFL schedule as the opponent source.
 * @param {Map<number, Record<string, {opponent: string, home: boolean}>>|null} byWeek
 */
export function setLiveSlate(byWeek) {
  liveSlate = byWeek && byWeek.size ? byWeek : null;
}

/** True when a given week's opponents come from the provider, not the round robin. */
export function hasLiveSlate(week) {
  return Boolean(liveSlate && liveSlate.has(Number(week)));
}

function buildSlate(weeks = 14) {
  const rounds = roundRobinRounds(NFL_ABBRS);
  const order = lcgShuffle(rounds.length, NFL_SCHEDULE_SEED);
  const byWeek = new Map();

  for (let week = 1; week <= weeks; week += 1) {
    const pairs = rounds[order[(week - 1) % rounds.length]];
    /** @type {Record<string, {opponent: string, home: boolean}>} */
    const map = {};
    pairs.forEach(([home, away]) => {
      map[home] = { opponent: away, home: true };
      map[away] = { opponent: home, home: false };
    });
    byWeek.set(week, map);
  }
  return byWeek;
}

/**
 * The opponent a franchise faces in a given week.
 * @param {string} abbr NFL team abbreviation
 * @param {number} week 1-based
 * @returns {{opponent: string, home: boolean}|null}
 */
export function nflOpponent(abbr, week) {
  const key = normalizeAbbr(abbr);

  const live = liveSlate?.get(Number(week))?.[key];
  if (live) return live;

  if (!slate) slate = buildSlate();
  return slate.get(week)?.[key] || null;
}

/** "@ MIA" / "vs NYJ" — the matchup label shown under a player's name. */
export function opponentLabel(abbr, week) {
  const game = nflOpponent(abbr, week);
  if (!game) return '—';
  return `${game.home ? 'vs' : '@'} ${game.opponent}`;
}
