/**
 * playerAssets.js
 * -----------------------------------------------------------------------------
 * Player imagery: the one place that decides what picture belongs next to a
 * player's name, and what to show when that picture does not arrive.
 *
 * The headshots come from the database. The player audit (migration `0007`)
 * resolved every row against the public id sets and wrote `espn_id` and
 * `headshot_url` onto `fsnv2.players`; `buildLivePool()` in js/liveData.js
 * carries both onto the Player objects the UI renders, and the static pool in
 * js/playerData.js declares them null because it has no imagery of its own.
 *
 * Two jobs live here:
 *
 *   headshotUrlFor()  read the URL off a database row or a Player, in either
 *                     spelling (`headshot_url` / `headshotUrl`), deriving it
 *                     from the ESPN id when the column is null
 *   avatarSources()   resolve the four things the avatar component renders —
 *                     the image, where to hop when it fails, the initials
 *                     underneath and the team whose badge sits in the corner
 *
 * The markup itself is `playerAvatar()` in js/uiRenderer.js.
 */

import { normalizeAbbr, teamColor, teamLogoUrl } from './nflTeams.js';

/** ESPN's headshot combiner — the host the audit wrote into the column. */
const ESPN_HEADSHOT_BASE = 'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full';

/** Derives a headshot from an ESPN id, for rows whose URL column is null. */
export function espnHeadshotUrl(espnId) {
  const id = espnId === undefined || espnId === null ? '' : String(espnId).trim();
  return /^\d+$/.test(id) ? `${ESPN_HEADSHOT_BASE}/${id}.png` : null;
}

/**
 * The headshot to try first: the stored URL, then one derived from the ESPN id.
 *
 * Reads both spellings so a raw `fsnv2.players` row resolves as happily as a
 * transformed Player — the snake_case one is what PostgREST hands us, and
 * taking either is what stops a rename on one side of the wire from silently
 * blanking every avatar.
 *
 * @param {import('./types.js').Player|Record<string, unknown>|null} player
 */
export function headshotUrlFor(player) {
  if (!player) return null;
  return (
    httpUrl(player.headshotUrl ?? player.headshot_url) ||
    espnHeadshotUrl(player.espnId ?? player.espn_id) ||
    null
  );
}

/** The ESPN id off either spelling, as a string — or null. */
export function espnIdFor(player) {
  const id = text(player?.espnId ?? player?.espn_id);
  return id && /^\d+$/.test(id) ? id : null;
}

/** "Lamar Jackson" -> "LJ", "Ravens D/ST" -> "BAL" (the chip under the image). */
export function avatarInitials(player) {
  if (!player) return '';
  const name = String(player.name || '');
  if (player.position === 'DST') return normalizeAbbr(player.team) || name.slice(0, 3).toUpperCase();

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
 *   team      the abbreviation for the corner badge; null for a D/ST, whose
 *             headshot *is* the team logo, and null when the logo is already
 *             standing in for the missing headshot
 *
 * Every field is driven by the player's current `team`, so a club change moves
 * the badge and the chip colour the moment the sync lands — the same property
 * `teamLogoHtml()` has, which is what the corner renders.
 *
 * @param {import('./types.js').Player|Record<string, unknown>} player
 */
export function avatarSources(player) {
  const team = normalizeAbbr(player?.team);
  const logo = teamLogoUrl(team);
  const headshot = headshotUrlFor(player);
  const src = headshot || logo || null;

  return {
    src,
    fallback: src && logo && src !== logo ? logo : null,
    initials: avatarInitials(player),
    color: teamColor(team),
    team: headshot && player?.position !== 'DST' ? team : null,
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
