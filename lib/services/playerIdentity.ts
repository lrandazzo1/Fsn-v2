/**
 * playerIdentity.ts
 * -----------------------------------------------------------------------------
 * The reconciliation itself: given the rows in `fsnv2.players` and the nflverse
 * reference, decide what each row *should* say.
 *
 * It is a pure function of its two inputs — no network, no database — which is
 * what makes the matching rules testable, and what lets `--dry-run` produce
 * exactly the plan the real run applies.
 *
 * Matching, in descending order of how much it can be trusted:
 *
 *   1. espn_id          a stored ESPN id, either in the column or as a Tank01
 *                       `external_id` (Tank01 keys players *by* their ESPN id,
 *                       which is why `tank01-3917315` and espn_id 3917315 are
 *                       the same man)
 *   2. sleeper_id / gsis_id / rotowire_id
 *   3. name + position   normalized: accents folded, punctuation and 'Jr./Sr./III'
 *                       dropped, position kept as a guard against the two Josh
 *                       Allens
 *   4. team defenses     matched on the franchise in the row's name
 *                       ('Vikings D/ST' -> MIN), since no person's id applies
 *
 * An id match wins over a name match even when the names disagree, because a
 * name is what *changes* (a player adds a suffix, a feed switches to a nickname)
 * and an id is what does not.
 *
 * What the audit will and will not overwrite:
 *
 *   team          rewritten from the reference only when the reference has the
 *                 player on a roster. A released or retired player keeps the
 *                 team he was last filed under and is reported, not blanked —
 *                 blanking a whole bench mid-season is worse than a stale code.
 *   ids           filled when missing. A *conflicting* id is never overwritten;
 *                 it is reported, because two feeds disagreeing about identity
 *                 is a data question, not something a migration should guess at.
 *   headshot_url  filled when missing, or refreshed on request.
 *   team code     normalized ('ARZ' -> 'ARI') even for a row that matched
 *                 nothing at all.
 */

import { normalizePlayerName, playerMatchKey, text } from './normalize.ts';
import {
  canonicalTeam,
  espnHeadshotUrl,
  espnTeamLogoUrl,
  isCanonicalTeam,
  teamFromDefenseName
} from './teams.ts';
import type { NflversePlayer } from './nflverse.ts';
import type { PlayerAuditRow } from './types.ts';

export type { PlayerAuditRow };

/**
 * Which external id a provider's `external_id` actually is. Tank01's `playerID`
 * is the player's ESPN id, so its rows reconcile on `espn_id` with no extra
 * lookup; a provider absent from this table is matched by name.
 */
export const PROVIDER_EXTERNAL_ID_KIND: Record<string, 'espn_id' | 'sleeper_id' | 'gsis_id'> = {
  tank01: 'espn_id',
  fixture: 'espn_id'
};

export type MatchMethod =
  | 'espn_id'
  | 'sleeper_id'
  | 'gsis_id'
  | 'rotowire_id'
  | 'provider_external_id'
  | 'name_position'
  | 'defense_team'
  | 'unmatched';

/** The columns the audit is allowed to write. */
export type AuditField = 'team' | 'headshot_url' | 'espn_id' | 'sleeper_id' | 'gsis_id' | 'rotowire_id' | 'jersey';

export interface PlayerAuditChange {
  id: string;
  name: string;
  position: string;
  match: MatchMethod;
  /** The reference player this row matched, for the log. */
  reference: string | null;
  /** Only the columns that actually differ. */
  fields: AuditField[];
  before: Partial<Record<AuditField, string | null>>;
  after: Partial<Record<AuditField, string | null>>;
  /** Something a human should look at: an id conflict, a released player. */
  notes: string[];
}

export interface ReconcileOptions {
  /** Overwrite a headshot that is already set. */
  refreshHeadshots?: boolean;
  /** Prefer the ESPN combiner URL over whatever the reference published. */
  preferEspnHeadshots?: boolean;
  /** Leave `team` alone — an ids-and-headshots-only pass. */
  skipTeams?: boolean;
  /** Leave `headshot_url` alone. */
  skipHeadshots?: boolean;
  /** Fill jersey numbers too. */
  includeJersey?: boolean;
}

export interface ReconcileReport {
  /** Rows with at least one column to change. */
  changes: PlayerAuditChange[];
  /** Rows that matched a reference player but need no change. */
  clean: number;
  /** Rows no matching rule could resolve. */
  unmatched: PlayerAuditChange[];
  counts: {
    rows: number;
    matched: number;
    teams: number;
    headshots: number;
    ids: number;
    jerseys: number;
    normalizedTeamCodes: number;
    conflicts: number;
  };
  /** Per-method match counts, for the run summary. */
  byMethod: Record<MatchMethod, number>;
}

/* ------------------------------------------------------------------- index -- */

export interface ReferenceIndex {
  byEspnId: Map<string, NflversePlayer>;
  bySleeperId: Map<string, NflversePlayer>;
  byGsisId: Map<string, NflversePlayer>;
  byRotowireId: Map<string, NflversePlayer>;
  /** normalized name + position. Ambiguous keys are dropped, not guessed. */
  byNameAndPosition: Map<string, NflversePlayer>;
  /** normalized name only — the fallback when a feed disagrees about position. */
  byName: Map<string, NflversePlayer>;
  /** Names that resolve to more than one player, so a name match is refused. */
  ambiguousNames: Set<string>;
  size: number;
}

/** Between two rows for the same key, the one actually on a roster wins. */
function preferred(candidate: NflversePlayer, incumbent: NflversePlayer): NflversePlayer {
  if (candidate.rostered !== incumbent.rostered) return candidate.rostered ? candidate : incumbent;
  if ((candidate.week ?? -1) !== (incumbent.week ?? -1)) {
    return (candidate.week ?? -1) > (incumbent.week ?? -1) ? candidate : incumbent;
  }
  return incumbent;
}

export function buildReferenceIndex(players: NflversePlayer[]): ReferenceIndex {
  const index: ReferenceIndex = {
    byEspnId: new Map(),
    bySleeperId: new Map(),
    byGsisId: new Map(),
    byRotowireId: new Map(),
    byNameAndPosition: new Map(),
    byName: new Map(),
    ambiguousNames: new Set(),
    size: players.length
  };

  const put = (map: Map<string, NflversePlayer>, key: string | null, player: NflversePlayer): void => {
    if (!key) return;
    const incumbent = map.get(key);
    map.set(key, incumbent ? preferred(player, incumbent) : player);
  };

  for (const player of players) {
    put(index.byEspnId, player.espn_id, player);
    put(index.bySleeperId, player.sleeper_id, player);
    put(index.byGsisId, player.gsis_id, player);
    put(index.byRotowireId, player.rotowire_id, player);

    const nameKey = normalizePlayerName(player.full_name);
    if (!nameKey) continue;
    put(index.byNameAndPosition, playerMatchKey(player.full_name, player.position), player);

    const incumbent = index.byName.get(nameKey);
    if (incumbent && identityKey(incumbent) !== identityKey(player)) {
      // Two different people share the name — a name-only match is unsafe.
      index.ambiguousNames.add(nameKey);
      index.byName.set(nameKey, preferred(player, incumbent));
    } else {
      put(index.byName, nameKey, player);
    }
  }

  return index;
}

const identityKey = (player: NflversePlayer): string =>
  player.gsis_id ?? player.espn_id ?? `name:${normalizePlayerName(player.full_name)}`;

/* ------------------------------------------------------------------ match -- */

export interface MatchResult {
  player: NflversePlayer | null;
  method: MatchMethod;
}

/** Resolves one database row against the reference index. */
export function matchPlayer(row: PlayerAuditRow, index: ReferenceIndex): MatchResult {
  const tryId = (map: Map<string, NflversePlayer>, value: unknown, method: MatchMethod): MatchResult | null => {
    const id = text(value);
    if (!id) return null;
    const player = map.get(id);
    return player ? { player, method } : null;
  };

  const byStoredId =
    tryId(index.byEspnId, row.espn_id, 'espn_id') ??
    tryId(index.byGsisId, row.gsis_id, 'gsis_id') ??
    tryId(index.bySleeperId, row.sleeper_id, 'sleeper_id') ??
    tryId(index.byRotowireId, row.rotowire_id, 'rotowire_id');
  if (byStoredId) return byStoredId;

  // A provider's own key, where we know which id it is.
  const provider = text(row.provider)?.toLowerCase();
  const kind = provider ? PROVIDER_EXTERNAL_ID_KIND[provider] : undefined;
  if (kind) {
    const map =
      kind === 'espn_id' ? index.byEspnId : kind === 'sleeper_id' ? index.bySleeperId : index.byGsisId;
    const viaProvider = tryId(map, row.external_id, 'provider_external_id');
    if (viaProvider) return viaProvider;
  }

  // Team defenses are a franchise, not a person.
  if (row.position?.toUpperCase() === 'DST') return { player: null, method: 'defense_team' };

  const withPosition = index.byNameAndPosition.get(playerMatchKey(row.name, row.position));
  if (withPosition) return { player: withPosition, method: 'name_position' };

  const nameKey = normalizePlayerName(row.name);
  if (nameKey && !index.ambiguousNames.has(nameKey)) {
    const byName = index.byName.get(nameKey);
    // Only when the position is compatible — a WR row must not take a DB hit on
    // a linebacker of the same name.
    if (byName && positionsAgree(row.position, byName.position)) {
      return { player: byName, method: 'name_position' };
    }
  }

  return { player: null, method: 'unmatched' };
}

/** nflverse publishes NFL positions; the pool stores fantasy ones. */
const POSITION_GROUPS: Record<string, string[]> = {
  QB: ['QB'],
  RB: ['RB', 'FB', 'HB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K', 'PK'],
  DST: ['DST', 'DEF']
};

export function positionsAgree(fantasyPosition: unknown, referencePosition: unknown): boolean {
  const ours = text(fantasyPosition)?.toUpperCase();
  const theirs = text(referencePosition)?.toUpperCase();
  if (!ours || !theirs) return true;
  const allowed = POSITION_GROUPS[ours];
  return allowed ? allowed.includes(theirs) : ours === theirs;
}

/* -------------------------------------------------------------- reconcile -- */

function headshotFor(player: NflversePlayer | null, options: ReconcileOptions): string | null {
  if (!player) return null;
  const espn = espnHeadshotUrl(player.espn_id);
  if (options.preferEspnHeadshots === false) return player.headshot_url ?? espn;
  return espn ?? player.headshot_url;
}

/**
 * Builds the change plan for one row. Returns null when the row is already
 * correct, so `changes` only ever holds real work.
 */
export function reconcilePlayer(
  row: PlayerAuditRow,
  index: ReferenceIndex,
  options: ReconcileOptions = {}
): PlayerAuditChange {
  const { player, method } = matchPlayer(row, index);
  const change: PlayerAuditChange = {
    id: row.id,
    name: row.name,
    position: row.position,
    match: method,
    reference: player ? player.full_name : null,
    fields: [],
    before: {},
    after: {},
    notes: []
  };

  const set = (field: AuditField, next: string | null): void => {
    const current = (row as unknown as Record<string, unknown>)[field];
    const before = text(current);
    if (next === null || next === before) return;
    change.fields.push(field);
    change.before[field] = before;
    change.after[field] = next;
  };

  /* team ------------------------------------------------------------------- */
  if (!options.skipTeams) {
    if (method === 'defense_team') {
      // A defense's franchise comes from its own name first — 'Vikings D/ST' is
      // MIN whatever the team column drifted to — and from the column only when
      // the name carries no franchise.
      const fromName = teamFromDefenseName(row.name);
      const resolved = fromName ?? canonicalTeam(row.team);
      if (resolved) set('team', resolved);
      else change.notes.push('no franchise could be resolved for this defense');
    } else if (player) {
      if (player.team && player.rostered) {
        set('team', player.team);
      } else if (player.team && !player.rostered) {
        const current = canonicalTeam(row.team);
        change.notes.push(
          `reference has this player off a roster (${player.status ?? 'unknown'}) — team left at ${current ?? row.team ?? 'unset'}`
        );
        if (current && current !== row.team) set('team', current);
      } else {
        const current = canonicalTeam(row.team);
        change.notes.push('reference lists no team for this player — team left as it was');
        if (current && current !== row.team) set('team', current);
      }
    } else {
      // Unmatched rows still get their team code canonicalized.
      const current = canonicalTeam(row.team);
      if (current && current !== row.team) set('team', current);
      else if (!current && row.team) change.notes.push(`team "${row.team}" is not a known franchise`);
    }
  }

  /* identifiers ------------------------------------------------------------ */
  if (player) {
    const ids: Array<[AuditField, string | null]> = [
      ['espn_id', player.espn_id],
      ['sleeper_id', player.sleeper_id],
      ['gsis_id', player.gsis_id],
      ['rotowire_id', player.rotowire_id]
    ];
    for (const [field, value] of ids) {
      if (!value) continue;
      const current = text((row as unknown as Record<string, unknown>)[field]);
      if (current === null) set(field, value);
      else if (current !== value) {
        change.notes.push(`${field} conflict: stored ${current}, reference ${value} — left as stored`);
      }
    }
    if (options.includeJersey && player.jersey && text(row.jersey) === null) set('jersey', player.jersey);
  }

  /* headshot --------------------------------------------------------------- */
  if (!options.skipHeadshots) {
    const current = text(row.headshot_url);
    const next =
      method === 'defense_team'
        ? espnTeamLogoUrl(
            change.after.team ?? row.team ?? teamFromDefenseName(row.name)
          )
        : headshotFor(player, options);
    if (next && (current === null || options.refreshHeadshots)) set('headshot_url', next);
    else if (!next && current === null) {
      change.notes.push(
        player ? 'no ESPN id and no published headshot for this player' : 'no headshot: row is unmatched'
      );
    }
  }

  return change;
}

/** Runs `reconcilePlayer` over every row and rolls the results up. */
export function reconcilePlayers(
  rows: PlayerAuditRow[],
  index: ReferenceIndex,
  options: ReconcileOptions = {}
): ReconcileReport {
  const changes: PlayerAuditChange[] = [];
  const unmatched: PlayerAuditChange[] = [];
  const byMethod: Record<MatchMethod, number> = {
    espn_id: 0,
    sleeper_id: 0,
    gsis_id: 0,
    rotowire_id: 0,
    provider_external_id: 0,
    name_position: 0,
    defense_team: 0,
    unmatched: 0
  };
  const counts = {
    rows: rows.length,
    matched: 0,
    teams: 0,
    headshots: 0,
    ids: 0,
    jerseys: 0,
    normalizedTeamCodes: 0,
    conflicts: 0
  };
  let clean = 0;

  for (const row of rows) {
    const change = reconcilePlayer(row, index, options);
    byMethod[change.match] += 1;
    if (change.match !== 'unmatched') counts.matched += 1;
    if (change.match === 'unmatched') unmatched.push(change);
    counts.conflicts += change.notes.filter((note) => note.includes('conflict')).length;

    for (const field of change.fields) {
      if (field === 'team') {
        counts.teams += 1;
        // A pure spelling fix is worth counting separately from a real move.
        const before = change.before.team;
        if (before && canonicalTeam(before) === change.after.team && !isCanonicalTeam(before)) {
          counts.normalizedTeamCodes += 1;
        }
      } else if (field === 'headshot_url') counts.headshots += 1;
      else if (field === 'jersey') counts.jerseys += 1;
      else counts.ids += 1;
    }

    if (change.fields.length > 0) changes.push(change);
    else clean += 1;
  }

  return { changes, clean, unmatched, counts, byMethod };
}

/** The write payload for `public.fsnv2_apply_player_audit`. */
export function toUpdatePayload(changes: PlayerAuditChange[]): Array<Record<string, string | null>> {
  return changes
    .filter((change) => change.fields.length > 0)
    .map((change) => {
      const row: Record<string, string | null> = { id: change.id };
      for (const field of change.fields) row[field] = change.after[field] ?? null;
      return row;
    });
}
