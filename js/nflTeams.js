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
 * Opponents come from the real NFL slate and from nothing else: app.js reads
 * `fsnv2_nfl_schedule` on boot and installs the result through `setLiveSlate()`,
 * and the label is then a lookup — "vs NYJ" at home, "@ MIA" on the road, "BYE"
 * when a synced week has no game for the franchise.
 *
 * There is no generated fallback. A week the sync has not stored reads '—',
 * because a synthetic fixture is indistinguishable from a real one on screen and
 * a wrong opponent is worse than an absent one. `hasLiveSlate(week)` says
 * whether a week is known at all, which is what separates 'BYE' from '—'.
 */

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
 * The real slate, once `fsnv2_nfl_schedule` has been read: week -> abbr ->
 * { opponent, home }. Only the weeks the sync has actually stored are in it —
 * a season three weeks old has three.
 *
 * There is deliberately no second, generated slate behind it. A synthetic round
 * robin is indistinguishable from a real fixture on screen, and that is exactly
 * how players ended up labelled "vs CLE" / "@ PIT" / "@ SEA" against teams they
 * were not playing. A week the sync has not reached reads '—', and a franchise
 * with no game in a week the sync *has* reached is on its bye.
 *
 * @type {Map<number, Record<string, {opponent: string, home: boolean}>>|null}
 */
let liveSlate = null;

/**
 * Installs the synced NFL schedule as the opponent source. Passing null (or an
 * empty map) clears it, which puts every label back to '—' rather than back
 * onto a generated fixture.
 * @param {Map<number, Record<string, {opponent: string, home: boolean}>>|null} byWeek
 */
export function setLiveSlate(byWeek) {
  liveSlate = byWeek && byWeek.size ? byWeek : null;
}

/** True once a week's real games are loaded — the difference between BYE and '—'. */
export function hasLiveSlate(week) {
  return Boolean(liveSlate && liveSlate.has(Number(week)));
}

/** The weeks the provider has actually given us, ascending. */
export function liveSlateWeeks() {
  return liveSlate ? [...liveSlate.keys()].sort((a, b) => a - b) : [];
}

/**
 * The game a franchise plays in a given week.
 * @param {string} abbr NFL team abbreviation, in any feed's spelling
 * @param {number} week 1-based
 * @returns {{opponent: string, home: boolean}|null} null on a bye — or when the
 *          week has not been synced; `hasLiveSlate(week)` separates the two
 */
export function nflOpponent(abbr, week) {
  const key = normalizeAbbr(abbr);
  if (!key) return null;
  return liveSlate?.get(Number(week))?.[key] ?? null;
}

/** True when the week is loaded and the franchise has no game in it. */
export function isByeWeek(abbr, week) {
  return hasLiveSlate(week) && nflOpponent(abbr, week) === null;
}

/**
 * The matchup label shown under a player's name:
 *
 *   "vs NYJ"  the player's team is the home side
 *   "@ MIA"   the player's team is the away side
 *   "BYE"     the week is synced and the team has no game in it
 *   "—"       the week has not been synced, so we do not know
 */
export function opponentLabel(abbr, week) {
  const game = nflOpponent(abbr, week);
  if (game) return `${game.home ? 'vs' : '@'} ${game.opponent}`;
  return hasLiveSlate(week) ? 'BYE' : '—';
}

/**
 * The same label for a player row. Prefers the opponent already stamped onto the
 * player by `annotatePlayers()` for that week, and otherwise reads the slate
 * directly — so a component can never render a stale stamp.
 */
export function playerOpponentLabel(player, week) {
  if (!player) return '—';
  if (player.opponentWeek === Number(week) && player.opponent) return player.opponent;
  return opponentLabel(player.team, week);
}

/**
 * Stamps a week's matchup onto every player, so the starting-lineup and bench
 * components read `{player.team}` and `{player.opponent}` straight off the
 * payload instead of each keeping a schedule of its own:
 *
 *   team          canonicalised to one of the 32 franchise codes
 *   opponent      'vs CLE' / '@ PIT' / 'BYE' / '—', exactly as above
 *   opponentTeam  the other franchise's abbreviation, or null
 *   isHome        true at home, false on the road, null with no game
 *   onBye         true only when the week is synced and the team has no game
 *
 * @param {Record<string, Object>|Array<Object>} players
 * @param {number} week
 * @returns {number} how many players were stamped
 */
export function annotatePlayers(players, week) {
  const target = Number(week);
  const rows = Array.isArray(players) ? players : Object.values(players ?? {});

  for (const player of rows) {
    if (!player) continue;
    player.team = normalizeAbbr(player.team) || player.team;
    const game = nflOpponent(player.team, target);
    player.opponentWeek = target;
    player.opponent = opponentLabel(player.team, target);
    player.opponentTeam = game?.opponent ?? null;
    player.isHome = game ? game.home : null;
    player.onBye = hasLiveSlate(target) && !game;
  }
  return rows.length;
}
