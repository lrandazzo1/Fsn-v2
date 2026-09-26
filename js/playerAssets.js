/**
 * playerAssets.js
 * -----------------------------------------------------------------------------
 * Player imagery: the seam between a `fsnv2.players` row and the two fields the
 * UI actually renders — `headshotUrl` and `espnId`.
 *
 * Why a module of its own:
 *  - the synthetic pool in playerData.js is four columns wide by design and
 *    carries no imagery at all, so `loadPlayers()` can only ever produce
 *    `headshotUrl: null`;
 *  - the headshots live in Postgres, next to the external ids the player audit
 *    resolved (`fsnv2.players.headshot_url`, `.espn_id`);
 *  - the transform between the two — snake_case to camelCase, id matching,
 *    fallback URLs — is the part that was missing, and it belongs in one place
 *    rather than smeared across the views.
 *
 * Pipeline:
 *   fsnv2_player_assets (RPC)
 *     -> normalizeAssetRow()   one row  -> { id, name, position, team, headshotUrl, espnId }
 *     -> indexPlayerAssets()   many rows -> { byId, byKey }
 *     -> applyPlayerAssets()   merged onto the enriched draft pool
 *     -> avatarSources()       the four things the <img> needs to render
 *
 * Matching is by row id first (`p-0042`, which the pool sync writes) and then by
 * name + position, so a provider row keyed `tank01-3916387` still lights up the
 * `p-0001` Lamar Jackson the draft board is built from. The name key mirrors
 * `public.fsnv2_player_key()` in SQL — lowercase, alphanumerics only — so both
 * sides of the wire agree on what "same player" means.
 */

import { teamColor, teamLogoUrl } from './nflTeams.js';

/** ESPN's headshot combiner — the same host the audit wrote into the column. */
const ESPN_HEADSHOT_BASE = 'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full';

/** Derives a headshot from an ESPN id, for rows whose URL column is still null. */
export function espnHeadshotUrl(espnId) {
  const id = espnId === undefined || espnId === null ? '' : String(espnId).trim();
  return /^\d+$/.test(id) ? `${ESPN_HEADSHOT_BASE}/${id}.png` : null;
}

/** Mirrors `public.fsnv2_player_key()`: "Ja'Marr Chase" -> "jamarrchase". */
export function playerNameKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** "jamarrchase|WR" — name and position together, because names repeat. */
export function playerMatchKey(name, position) {
  const key = playerNameKey(name);
  return key ? `${key}|${String(position || '').toUpperCase()}` : null;
}

/**
 * One database row -> the shape the UI speaks.
 *
 * Accepts both spellings of every field: PostgREST hands us `headshot_url` and
 * `espn_id`, while a caller that has already transformed a row (or a fixture in
 * the test-suite) may pass `headshotUrl` / `espnId`. Taking either is what stops
 * a rename on one side of the wire from silently blanking the avatars.
 *
 * @param {Record<string, unknown>} row
 * @returns {{id: string|null, name: string|null, position: string|null, team: string|null,
 *            headshotUrl: string|null, espnId: string|null}|null}
 */
export function normalizeAssetRow(row) {
  if (!row || typeof row !== 'object') return null;

  const id = text(row.id);
  const name = text(row.name);
  const position = text(row.position)?.toUpperCase() ?? null;
  const team = text(row.team)?.toUpperCase() ?? null;
  const espnId = text(row.espn_id ?? row.espnId);
  const headshotUrl = httpUrl(row.headshot_url ?? row.headshotUrl) || espnHeadshotUrl(espnId);

  if (!id && !name) return null;
  return { id, name, position, team, headshotUrl, espnId };
}

/**
 * Builds the lookup the merge walks: by row id, and by name+position.
 *
 * Rows that carry a headshot win over rows that do not, so the synced
 * `tank01-*` row for a player beats a bare local row and the pool always ends
 * up with the best image the database has.
 *
 * @param {Array<Record<string, unknown>>|null|undefined} rows
 */
export function indexPlayerAssets(rows) {
  /** @type {Map<string, ReturnType<typeof normalizeAssetRow>>} */
  const byId = new Map();
  /** @type {Map<string, ReturnType<typeof normalizeAssetRow>>} */
  const byKey = new Map();

  (Array.isArray(rows) ? rows : []).forEach((raw) => {
    const asset = normalizeAssetRow(raw);
    if (!asset) return;

    if (asset.id && better(byId.get(asset.id), asset)) byId.set(asset.id, asset);

    const key = playerMatchKey(asset.name, asset.position);
    if (key && better(byKey.get(key), asset)) byKey.set(key, asset);
  });

  return { byId, byKey, size: byId.size || byKey.size };
}

/** An empty index — what the UI runs against offline, or before the fetch lands. */
export function emptyPlayerAssets() {
  return { byId: new Map(), byKey: new Map(), size: 0 };
}

/** The asset for one player, id first and name+position second. */
export function lookupPlayerAsset(index, player) {
  if (!index || !player) return null;
  return (
    index.byId?.get(player.id) ||
    index.byKey?.get(playerMatchKey(player.name, player.position)) ||
    null
  );
}

/**
 * Merges an index into an already-enriched pool, in place.
 *
 * Only ever *adds* imagery: a player who already has a headshot keeps it, so
 * re-running the merge after a reset or a later fetch can never blank an avatar
 * that is on screen.
 *
 * @param {Record<string, import('./types.js').Player>} playersById
 * @param {ReturnType<typeof indexPlayerAssets>} index
 * @returns {number} how many players gained a headshot
 */
export function applyPlayerAssets(playersById, index) {
  if (!playersById || !index) return 0;
  let matched = 0;

  Object.values(playersById).forEach((player) => {
    const asset = lookupPlayerAsset(index, player);
    if (!asset) return;
    if (asset.espnId && !player.espnId) player.espnId = asset.espnId;
    if (asset.headshotUrl && player.headshotUrl !== asset.headshotUrl) {
      player.headshotUrl = asset.headshotUrl;
      matched += 1;
    }
  });

  return matched;
}

/**
 * The headshot to try first: the column, then a URL derived from the ESPN id.
 * Reads both spellings so a raw database row renders as happily as a Player.
 */
export function headshotUrlFor(player) {
  if (!player) return null;
  return (
    httpUrl(player.headshotUrl ?? player.headshot_url) ||
    espnHeadshotUrl(player.espnId ?? player.espn_id) ||
    null
  );
}

/** "Lamar Jackson" -> "LJ", "Ravens D/ST" -> "BAL" (the chip under the image). */
export function avatarInitials(player) {
  if (!player) return '';
  const name = String(player.name || '');
  if (player.position === 'DST') return String(player.team || name.slice(0, 3)).toUpperCase();

  const words = name.replace(/[^A-Za-z .'-]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

/**
 * Everything the avatar component needs, resolved once:
 *
 *   src       the headshot, or the team logo when there is no headshot
 *   fallback  where the <img> hops on an error — the team logo, unless that is
 *             already the src, in which case the initials chip takes over
 *   initials  rendered *behind* the image, so a blocked CDN degrades to a
 *             coloured chip instead of a broken-image icon
 *   teamLogo  the corner overlay; null for a D/ST, whose headshot *is* the logo
 *
 * @param {import('./types.js').Player|Record<string, unknown>} player
 */
export function avatarSources(player) {
  const team = String(player?.team || '').toUpperCase();
  const logo = teamLogoUrl(team);
  const headshot = headshotUrlFor(player);
  const src = headshot || logo || null;

  return {
    src,
    fallback: src && logo && src !== logo ? logo : null,
    initials: avatarInitials(player),
    color: teamColor(team),
    teamLogo: player?.position === 'DST' || !headshot ? null : logo,
    isHeadshot: Boolean(headshot)
  };
}

/* ----------------------------------------------------------------- helpers */

/** Trimmed non-empty string, or null — feeds send '' and 'null' alike. */
function text(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' || trimmed === 'null' || trimmed === 'undefined' ? null : trimmed;
}

/** Only http(s) URLs reach an `src` — never a `javascript:` or `data:` payload. */
function httpUrl(value) {
  const raw = text(value);
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
}

/** Prefers the candidate that actually has an image. */
function better(current, candidate) {
  if (!current) return true;
  if (current.headshotUrl && !candidate.headshotUrl) return false;
  return Boolean(candidate.headshotUrl) || !current.headshotUrl;
}
