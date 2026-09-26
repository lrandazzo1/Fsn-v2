/**
 * teams.ts
 * -----------------------------------------------------------------------------
 * One canonical spelling for every NFL franchise, and the alias table that maps
 * every other spelling onto it.
 *
 * Why this file exists: the same franchise arrives as `ARI` from one feed, `ARZ`
 * from another and `CRD` from a third; the Commanders are `WAS` here and `WSH`
 * on ESPN; nflverse calls the Rams `LA` while the draft board calls them `LAR`.
 * Left alone, those spellings split one team into three across
 * `fsnv2.players.team`, `fsnv2.projections.team` and the scoreboard, and a
 * roster filter silently drops players.
 *
 * Just as important is what this file *refuses*. A provider that keys its roster
 * payload by numeric team id (Tank01's `teamID`, an array index) used to leak
 * that number into the team column — `teamAbv: 21` became the team "21", which
 * is how Kyler Murray ended up filed under a number instead of a franchise.
 * `canonicalTeam()` returns null for anything numeric or unknown, so a caller
 * has to decide what to do rather than storing a junk code.
 *
 * The 32 abbreviations here are the ones js/nflTeams.js renders, so anything
 * that survives normalization has colours and a logo in the UI.
 */

export interface NflFranchise {
  abbr: string;
  city: string;
  /** The nickname on its own — 'Vikings', '49ers'. Used to resolve DST rows. */
  nickname: string;
  /** ESPN's abbreviation, where it differs from ours (logo/headshot CDN paths). */
  espnSlug: string;
  conference: 'AFC' | 'NFC';
  division: 'East' | 'North' | 'South' | 'West';
}

/** The 32 franchises, keyed by the abbreviation this system stores. */
export const NFL_FRANCHISES: Record<string, NflFranchise> = {
  ARI: { abbr: 'ARI', city: 'Arizona', nickname: 'Cardinals', espnSlug: 'ari', conference: 'NFC', division: 'West' },
  ATL: { abbr: 'ATL', city: 'Atlanta', nickname: 'Falcons', espnSlug: 'atl', conference: 'NFC', division: 'South' },
  BAL: { abbr: 'BAL', city: 'Baltimore', nickname: 'Ravens', espnSlug: 'bal', conference: 'AFC', division: 'North' },
  BUF: { abbr: 'BUF', city: 'Buffalo', nickname: 'Bills', espnSlug: 'buf', conference: 'AFC', division: 'East' },
  CAR: { abbr: 'CAR', city: 'Carolina', nickname: 'Panthers', espnSlug: 'car', conference: 'NFC', division: 'South' },
  CHI: { abbr: 'CHI', city: 'Chicago', nickname: 'Bears', espnSlug: 'chi', conference: 'NFC', division: 'North' },
  CIN: { abbr: 'CIN', city: 'Cincinnati', nickname: 'Bengals', espnSlug: 'cin', conference: 'AFC', division: 'North' },
  CLE: { abbr: 'CLE', city: 'Cleveland', nickname: 'Browns', espnSlug: 'cle', conference: 'AFC', division: 'North' },
  DAL: { abbr: 'DAL', city: 'Dallas', nickname: 'Cowboys', espnSlug: 'dal', conference: 'NFC', division: 'East' },
  DEN: { abbr: 'DEN', city: 'Denver', nickname: 'Broncos', espnSlug: 'den', conference: 'AFC', division: 'West' },
  DET: { abbr: 'DET', city: 'Detroit', nickname: 'Lions', espnSlug: 'det', conference: 'NFC', division: 'North' },
  GB: { abbr: 'GB', city: 'Green Bay', nickname: 'Packers', espnSlug: 'gb', conference: 'NFC', division: 'North' },
  HOU: { abbr: 'HOU', city: 'Houston', nickname: 'Texans', espnSlug: 'hou', conference: 'AFC', division: 'South' },
  IND: { abbr: 'IND', city: 'Indianapolis', nickname: 'Colts', espnSlug: 'ind', conference: 'AFC', division: 'South' },
  JAX: { abbr: 'JAX', city: 'Jacksonville', nickname: 'Jaguars', espnSlug: 'jax', conference: 'AFC', division: 'South' },
  KC: { abbr: 'KC', city: 'Kansas City', nickname: 'Chiefs', espnSlug: 'kc', conference: 'AFC', division: 'West' },
  LAC: { abbr: 'LAC', city: 'Los Angeles', nickname: 'Chargers', espnSlug: 'lac', conference: 'AFC', division: 'West' },
  LAR: { abbr: 'LAR', city: 'Los Angeles', nickname: 'Rams', espnSlug: 'lar', conference: 'NFC', division: 'West' },
  LV: { abbr: 'LV', city: 'Las Vegas', nickname: 'Raiders', espnSlug: 'lv', conference: 'AFC', division: 'West' },
  MIA: { abbr: 'MIA', city: 'Miami', nickname: 'Dolphins', espnSlug: 'mia', conference: 'AFC', division: 'East' },
  MIN: { abbr: 'MIN', city: 'Minnesota', nickname: 'Vikings', espnSlug: 'min', conference: 'NFC', division: 'North' },
  NE: { abbr: 'NE', city: 'New England', nickname: 'Patriots', espnSlug: 'ne', conference: 'AFC', division: 'East' },
  NO: { abbr: 'NO', city: 'New Orleans', nickname: 'Saints', espnSlug: 'no', conference: 'NFC', division: 'South' },
  NYG: { abbr: 'NYG', city: 'New York', nickname: 'Giants', espnSlug: 'nyg', conference: 'NFC', division: 'East' },
  NYJ: { abbr: 'NYJ', city: 'New York', nickname: 'Jets', espnSlug: 'nyj', conference: 'AFC', division: 'East' },
  PHI: { abbr: 'PHI', city: 'Philadelphia', nickname: 'Eagles', espnSlug: 'phi', conference: 'NFC', division: 'East' },
  PIT: { abbr: 'PIT', city: 'Pittsburgh', nickname: 'Steelers', espnSlug: 'pit', conference: 'AFC', division: 'North' },
  SEA: { abbr: 'SEA', city: 'Seattle', nickname: 'Seahawks', espnSlug: 'sea', conference: 'NFC', division: 'West' },
  SF: { abbr: 'SF', city: 'San Francisco', nickname: '49ers', espnSlug: 'sf', conference: 'NFC', division: 'West' },
  TB: { abbr: 'TB', city: 'Tampa Bay', nickname: 'Buccaneers', espnSlug: 'tb', conference: 'NFC', division: 'South' },
  TEN: { abbr: 'TEN', city: 'Tennessee', nickname: 'Titans', espnSlug: 'ten', conference: 'AFC', division: 'South' },
  WAS: { abbr: 'WAS', city: 'Washington', nickname: 'Commanders', espnSlug: 'wsh', conference: 'NFC', division: 'East' }
};

/** Every abbreviation this system stores, in the order the UI lists them. */
export const CANONICAL_TEAMS: string[] = Object.keys(NFL_FRANCHISES).sort();

/**
 * Non-canonical spelling -> canonical abbreviation.
 *
 * Sources, so a future addition has somewhere to slot in:
 *   ESPN          WSH
 *   nflverse      LA (Rams), and the historical relocations below
 *   Tank01/Sleeper JAC, LVR, WSH
 *   PFR           CRD RAV OTI HTX CLT RAI SDG SFO GNB KAN NWE NOR TAM
 *   relocations   OAK/RAI -> LV, SD/SDG -> LAC, STL -> LAR, WFT -> WAS
 */
export const TEAM_ALIASES: Record<string, string> = {
  ARZ: 'ARI',
  CRD: 'ARI',
  BLT: 'BAL',
  RAV: 'BAL',
  CLV: 'CLE',
  GNB: 'GB',
  GBP: 'GB',
  HST: 'HOU',
  HTX: 'HOU',
  CLT: 'IND',
  JAC: 'JAX',
  JAG: 'JAX',
  KAN: 'KC',
  KCC: 'KC',
  SD: 'LAC',
  SDG: 'LAC',
  LA: 'LAR',
  RAM: 'LAR',
  STL: 'LAR',
  LVR: 'LV',
  OAK: 'LV',
  RAI: 'LV',
  NWE: 'NE',
  NEP: 'NE',
  NOR: 'NO',
  NOS: 'NO',
  SFO: 'SF',
  TAM: 'TB',
  TBB: 'TB',
  OTI: 'TEN',
  WSH: 'WAS',
  WFT: 'WAS'
};

/**
 * Codes a feed uses for "no team", which belong in the `FA` bucket rather than
 * being stored verbatim and read later as a franchise.
 */
const FREE_AGENT_CODES = new Set(['FA', 'FREE', 'NONE', 'NA', 'N/A', 'UFA', 'RFA', 'RET', '00', '0']);

/** nickname/city+nickname -> abbr, so 'Vikings D/ST' and '49ers' both resolve. */
const NAME_INDEX: Record<string, string> = (() => {
  const index: Record<string, string> = {};
  const put = (label: string, abbr: string): void => {
    const key = label.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (key) index[key] = abbr;
  };
  for (const team of Object.values(NFL_FRANCHISES)) {
    put(team.nickname, team.abbr);
    put(`${team.city} ${team.nickname}`, team.abbr);
    put(team.city, team.abbr);
  }
  // Two franchises share a city, so the bare city is ambiguous for both pairs —
  // drop it rather than pick one.
  delete index['LOSANGELES'];
  delete index['NEWYORK'];
  // Names the league and its partners still print for the same clubs.
  put('Washington Football Team', 'WAS');
  put('Redskins', 'WAS');
  put('Oakland Raiders', 'LV');
  put('San Diego Chargers', 'LAC');
  put('St. Louis Rams', 'LAR');
  return index;
})();

/**
 * The canonical abbreviation for a team, or null when the value is not a team
 * at all.
 *
 * Null — not a guess — is the point. Numeric input is the tell of a provider's
 * internal team id or an array index reaching a column that holds franchise
 * codes, and storing it would quietly corrupt every roster read that follows.
 */
export function canonicalTeam(value: unknown): string | null {
  const raw =
    typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  if (FREE_AGENT_CODES.has(upper)) return null;
  // A pure number is an id, never an abbreviation.
  if (/^\d+$/.test(trimmed)) return null;

  const compact = upper.replace(/[^A-Z0-9]/g, '');
  if (!compact) return null;
  if (NFL_FRANCHISES[compact]) return compact;
  if (TEAM_ALIASES[compact]) return TEAM_ALIASES[compact];
  return NAME_INDEX[compact] ?? null;
}

/** True when `value` already is one of the 32 abbreviations we store. */
export function isCanonicalTeam(value: unknown): boolean {
  return typeof value === 'string' && Object.hasOwn(NFL_FRANCHISES, value);
}

/**
 * The canonical abbreviation, or `fallback` ('FA') when the value resolves to no
 * franchise. Use this where a column must hold something; use `canonicalTeam()`
 * where "unknown" needs to stay distinguishable from "free agent".
 */
export function normalizeTeam(value: unknown, fallback = 'FA'): string {
  return canonicalTeam(value) ?? fallback;
}

/**
 * The franchise a team-defense row belongs to: 'Vikings D/ST' -> MIN,
 * '49ers D/ST' -> SF, 'DST-SF' -> SF. Returns null for a person's name.
 */
export function teamFromDefenseName(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : '';
  if (!raw.trim()) return null;
  const stripped = raw
    .replace(/\b(D\/ST|DST|DEF|DEFENSE|SPECIAL TEAMS)\b/gi, ' ')
    .replace(/[-_]/g, ' ')
    .trim();
  return canonicalTeam(stripped) ?? canonicalTeam(raw);
}

/** ESPN's 500px team logo — the DST stand-in for a player headshot. */
export function espnTeamLogoUrl(team: unknown): string | null {
  const abbr = canonicalTeam(team);
  if (!abbr) return null;
  return `https://a.espncdn.com/i/teamlogos/nfl/500/${NFL_FRANCHISES[abbr].espnSlug}.png`;
}

/**
 * ESPN's headshot combiner URL for a player's ESPN id. The combiner serves a
 * transparent PNG for an id it does not know rather than a 404, so a wrong id
 * degrades to a blank portrait instead of a broken image.
 */
export function espnHeadshotUrl(espnId: unknown): string | null {
  const id = typeof espnId === 'number' ? String(espnId) : typeof espnId === 'string' ? espnId.trim() : '';
  if (!/^\d+$/.test(id)) return null;
  return `https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${id}.png`;
}
