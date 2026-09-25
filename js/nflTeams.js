/**
 * nflTeams.js
 * -----------------------------------------------------------------------------
 * NFL franchise metadata and the real weekly slate.
 *
 * Two jobs:
 *
 *  1. Static presentation metadata — primary colours and a CDN logo per
 *     franchise. Logos come from a CDN, and — like the Tailwind/Lucide layers in
 *     index.html — the UI has to survive that CDN being blocked, so
 *     `teamLogoHtml()` renders the abbreviation in the team's colour *behind*
 *     the image and a failed load falls back to a coloured chip.
 *
 *  2. The weekly slate — who a franchise plays in a given week, and whether it
 *     is at home. This module holds **no schedule of its own**: it is filled by
 *     `setNflSchedule()` with the real games synced from Tank01
 *     (`/getNFLGamesForWeek` → fsnv2.nfl_matchups → `fsnv2_nfl_schedule`).
 *
 *     Until a week's games are loaded, `opponentLabel()` reports '—'. Once they
 *     are, a franchise with no game that week is on its bye and reads 'BYE'.
 *     There is deliberately no synthetic fallback slate: a made-up round robin
 *     is indistinguishable from real data in the UI, and that is exactly how
 *     "vs CLE / @ PIT / @ SEA" ended up next to players whose teams were not
 *     playing those opponents at all.
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

/** Stable alphabetical order. */
export const NFL_ABBRS = Object.keys(NFL_TEAMS).sort();

const LOGO_BASE = 'https://a.espncdn.com/i/teamlogos/nfl/500';

/**
 * Feeds disagree about a handful of abbreviations — Tank01 says WSH for
 * Washington and JAC for Jacksonville, older feeds still carry relocated
 * franchises. Everything is folded onto the keys of NFL_TEAMS on the way in, so
 * a live team code always finds its colour, its logo and its games.
 */
const TEAM_ALIASES = {
  WSH: 'WAS', WFT: 'WAS', WSN: 'WAS',
  JAC: 'JAX',
  LA: 'LAR', STL: 'LAR', RAM: 'LAR',
  SD: 'LAC', SDG: 'LAC',
  OAK: 'LV', RAI: 'LV', LVR: 'LV',
  ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU',
  TAM: 'TB', KAN: 'KC', NOR: 'NO', NWE: 'NE', SFO: 'SF', GNB: 'GB',
  NOS: 'NO', TBB: 'TB'
};

/** Folds any feed's spelling of a team code onto ours. Returns null for junk. */
export function normalizeTeamAbbr(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().toUpperCase();
  if (!raw) return null;
  const abbr = TEAM_ALIASES[raw] || raw;
  return NFL_TEAMS[abbr] ? abbr : null;
}

export function teamColor(abbr) {
  return NFL_TEAMS[normalizeTeamAbbr(abbr)]?.color || '#475569';
}

export function teamName(abbr) {
  const key = normalizeTeamAbbr(abbr);
  return key ? NFL_TEAMS[key].name : String(abbr ?? '');
}

/** CDN logo URL for a team abbreviation — the synced one when we have it. */
export function teamLogoUrl(abbr) {
  const key = normalizeTeamAbbr(abbr);
  if (!key) return null;
  const meta = NFL_TEAMS[key];
  return meta.logoUrl || `${LOGO_BASE}/${(meta.slug || key).toLowerCase()}.png`;
}

/**
 * Applies the synced `fsnv2_nfl_teams` rows (Tank01 `/getNFLTeams`) over the
 * static table: the provider's own logo and this season's bye week. Colours stay
 * local — Tank01 does not publish them.
 * @param {Array<Object>} rows
 * @returns {number} how many franchises were matched
 */
export function applyNflTeamMeta(rows = []) {
  let applied = 0;
  for (const row of rows) {
    const abbr = normalizeTeamAbbr(row?.abbr ?? row?.teamAbv ?? row?.team);
    if (!abbr) continue;
    const meta = NFL_TEAMS[abbr];
    const logo = row.logo_url ?? row.espnLogo1 ?? null;
    if (logo) meta.logoUrl = logo;
    const bye = Number(row.bye_week ?? row.byeWeek);
    if (Number.isInteger(bye) && bye > 0) meta.byeWeek = bye;
    meta.externalId = row.external_id ?? row.teamID ?? meta.externalId ?? null;
    applied += 1;
  }
  return applied;
}

/** teamID -> abbr, from the synced `/getNFLTeams` dictionary. */
export function teamIdIndex(rows = []) {
  const index = new Map();
  for (const row of rows) {
    const abbr = normalizeTeamAbbr(row?.abbr ?? row?.teamAbv);
    const id = row?.external_id ?? row?.teamID;
    if (abbr && id !== undefined && id !== null) index.set(String(id), abbr);
  }
  return index;
}

/* ------------------------------------------------------------ the real slate */

/**
 * week -> { [abbr]: { opponent, home, gameId, kickoff, status } }
 * Empty until `setNflSchedule()` is handed real games.
 * @type {Map<number, Record<string, {opponent: string, home: boolean, gameId: string|null, kickoff: string|null, status: string|null}>>}
 */
const slate = new Map();

/** '20260913_CHI@MIN' -> { away: 'CHI', home: 'MIN' } */
function teamsFromGameId(gameId) {
  const match = /_([A-Z]{2,4})@([A-Z]{2,4})$/.exec(String(gameId ?? '').toUpperCase());
  return match
    ? { away: normalizeTeamAbbr(match[1]), home: normalizeTeamAbbr(match[2]) }
    : { away: null, home: null };
}

/** 'Week 3' / '3' / 3 -> 3 */
function weekOf(value) {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D+/g, '');
  if (!digits) return null;
  const week = Number.parseInt(digits, 10);
  return Number.isInteger(week) && week >= 1 && week <= 22 ? week : null;
}

/**
 * Reads one game from either shape we are handed: a normalised
 * `fsnv2_nfl_schedule` row (`home_team` / `away_team` / `week`) or a raw Tank01
 * `/getNFLGamesForWeek` — or `/getNFLGamesForDate` — entry (`home` / `away` /
 * `gameWeek`, with `gameID` as the last resort for both).
 */
function readGame(row) {
  if (!row || typeof row !== 'object') return null;
  const gameId = row.external_id ?? row.gameID ?? null;
  const fromId = teamsFromGameId(gameId);

  const home = normalizeTeamAbbr(row.home_team ?? row.home ?? row.homeTeam) ?? fromId.home;
  const away = normalizeTeamAbbr(row.away_team ?? row.away ?? row.awayTeam) ?? fromId.away;
  if (!home || !away || home === away) return null;

  const week = weekOf(row.week ?? row.gameWeek);
  if (week === null) return null;

  return {
    week,
    home,
    away,
    gameId: gameId ? String(gameId) : null,
    kickoff: row.kickoff ?? row.gameTimeISO ?? null,
    status: row.status ?? row.gameStatus ?? null
  };
}

/**
 * Replaces the slate with real games.
 *
 * Each game writes both sides, so the lookup below is a plain read rather than
 * a scan:
 *   home -> { opponent: away, home: true }   renders 'vs AWAY'
 *   away -> { opponent: home, home: false }  renders '@ HOME'
 *
 * @param {Array<Object>} games rows from `fsnv2_nfl_schedule` or raw Tank01 games
 * @returns {{weeks: number[], games: number}}
 */
export function setNflSchedule(games = []) {
  slate.clear();
  let count = 0;

  for (const row of games) {
    const game = readGame(row);
    if (!game) continue;
    if (!slate.has(game.week)) slate.set(game.week, {});
    const map = slate.get(game.week);
    const shared = { gameId: game.gameId, kickoff: game.kickoff, status: game.status };
    map[game.home] = { opponent: game.away, home: true, ...shared };
    map[game.away] = { opponent: game.home, home: false, ...shared };
    count += 1;
  }

  return { weeks: [...slate.keys()].sort((a, b) => a - b), games: count };
}

/** Drops every loaded game — the UI falls back to '—', never to invented games. */
export function clearNflSchedule() {
  slate.clear();
}

/** The weeks we hold real games for, ascending. */
export function scheduleWeeks() {
  return [...slate.keys()].sort((a, b) => a - b);
}

/** True once a week's games are loaded — the difference between BYE and '—'. */
export function hasNflSchedule(week) {
  return slate.has(Number(week));
}

/**
 * The game a franchise plays in a given week.
 * @param {string} abbr NFL team abbreviation, in any feed's spelling
 * @param {number} week 1-based
 * @returns {{opponent: string, home: boolean, gameId: string|null, kickoff: string|null, status: string|null}|null}
 *          null when the team is on bye that week — or when the week is not loaded
 */
export function nflOpponent(abbr, week) {
  const team = normalizeTeamAbbr(abbr);
  if (!team) return null;
  return slate.get(Number(week))?.[team] ?? null;
}

/** True when the week is loaded and the franchise has no game in it. */
export function isByeWeek(abbr, week) {
  return hasNflSchedule(week) && nflOpponent(abbr, week) === null;
}

/**
 * The matchup label under a player's name: "vs NYJ" at home, "@ MIA" on the
 * road, "BYE" on the franchise's bye, and "—" while the week is still unloaded.
 */
export function opponentLabel(abbr, week) {
  const game = nflOpponent(abbr, week);
  if (game) return `${game.home ? 'vs' : '@'} ${game.opponent}`;
  return hasNflSchedule(week) ? 'BYE' : '—';
}

/**
 * The same label for a player row. Prefers the opponent already sanitised onto
 * the player by `annotatePlayers()` for the active week, so a lineup component
 * can render `{player.team}` / `{player.opponent}` straight out of the payload —
 * and still reads the slate directly for any other week, so a component can
 * never render a stale stamp.
 */
export function playerOpponentLabel(player, week) {
  if (!player) return '—';
  if (player.opponentWeek === Number(week) && player.opponent) return player.opponent;
  return opponentLabel(player.team, week);
}

/**
 * Stamps a week's matchup onto every player, so the starting-lineup and bench
 * components can read `{player.team}` and `{player.opponent}` out of the payload
 * instead of each keeping a schedule of its own:
 *
 *   opponent      'vs CLE' at home, '@ PIT' on the road, 'BYE', or '—' unloaded
 *   opponentTeam  the other franchise's abbreviation, or null
 *   isHome        true at home, false on the road, null with no game
 *   onBye         true only when the week is loaded and the team has no game
 *
 * @param {Record<string, Object>|Array<Object>} players
 * @param {number} week
 */
export function annotatePlayers(players, week) {
  const target = Number(week);
  const rows = Array.isArray(players) ? players : Object.values(players ?? {});
  for (const player of rows) {
    if (!player) continue;
    player.team = normalizeTeamAbbr(player.team) ?? player.team;
    const game = nflOpponent(player.team, target);
    player.opponentWeek = target;
    player.opponent = opponentLabel(player.team, target);
    player.opponentTeam = game?.opponent ?? null;
    player.isHome = game ? game.home : null;
    player.onBye = hasNflSchedule(target) && !game;
  }
  return rows.length;
}
