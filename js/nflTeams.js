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
 * The 14-week opponent schedule is synthetic, exactly like the projections in
 * playerData.js: a 32-team round robin whose rounds are drawn by the same
 * seeded shuffle the league schedule uses. It is stable across reloads, gives
 * every team an opponent every week, and is only ever used as display context
 * next to a player's name ("@ MIA", "vs NYJ").
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

const LOGO_BASE = 'https://a.espncdn.com/i/teamlogos/nfl/500';

/** Seed for the synthetic NFL slate — independent of the league schedule seed. */
const NFL_SCHEDULE_SEED = 90210;

export function teamColor(abbr) {
  return NFL_TEAMS[abbr]?.color || '#475569';
}

export function teamName(abbr) {
  return NFL_TEAMS[abbr]?.name || abbr;
}

/** CDN logo URL for a team abbreviation. */
export function teamLogoUrl(abbr) {
  const meta = NFL_TEAMS[abbr];
  if (!meta) return null;
  return `${LOGO_BASE}/${(meta.slug || abbr).toLowerCase()}.png`;
}

/* --------------------------------------------------------- weekly opponents */

/**
 * week -> { [abbr]: { opponent, home } }
 * Built once on first use: 32 teams give 31 round-robin rounds, and the seeded
 * shuffle picks which of them become weeks 1-14.
 */
let slate = null;

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
  if (!slate) slate = buildSlate();
  return slate.get(week)?.[abbr] || null;
}

/** "@ MIA" / "vs NYJ" — the matchup label shown under a player's name. */
export function opponentLabel(abbr, week) {
  const game = nflOpponent(abbr, week);
  if (!game) return '—';
  return `${game.home ? 'vs' : '@'} ${game.opponent}`;
}
