/** Sleeper market fields are distinct from our projection and VOR ranks. */
import { inactiveStatus } from './statsEngine.js';

export const MISSING_MARKET_RANK = 999;
export const FREE_AGENT_RANK_FLOOR = 220;
export const INACTIVE_DRAFT_RANK_FLOOR = 151;

export function draftRestricted(player) {
  return ['EX', 'SUS', 'IR', 'OUT'].includes(inactiveStatus(player));
}

export function validRank(value) {
  const rank = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(rank) && rank > 0
    ? rank : null;
}

export function marketRank(player) {
  const rank = validRank(player.sleeperAdp) ?? validRank(player.searchRank) ?? MISSING_MARKET_RANK;
  return draftRestricted(player) ? Math.max(rank, INACTIVE_DRAFT_RANK_FLOOR) : rank;
}

export function compareMarket(a, b) {
  return marketRank(a) - marketRank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

const nameKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Prefer scoring-specific ADP, then Sleeper's search rank. Never derive ADP from VOR. */
export function mapSleeperMarket(players, records, scoringType = 'ppr') {
  const field = { ppr: 'adp_ppr', half_ppr: 'adp_half_ppr', half: 'adp_half_ppr', std: 'adp_std' }[scoringType] || 'adp_ppr';
  const byName = new Map(Object.entries(records).map(([name, row]) => [nameKey(name), row]));
  return players.map((player) => {
    const record = byName.get(nameKey(player.name));
    const team = record ? (record.team || 'FA') : player.team;
    const unsigned = team === 'FA' && player.position !== 'DST';
    const adp = validRank(record ? record[field] : player.sleeperAdp);
    const searchRank = validRank(record ? record.search_rank : player.searchRank);
    // An unsigned player must not jump back into the early rounds via an old search rank.
    const sleeperAdp = unsigned && adp !== null ? Math.max(adp, FREE_AGENT_RANK_FLOOR) : adp;
    const effectiveSearchRank = unsigned && searchRank !== null
      ? Math.max(searchRank, FREE_AGENT_RANK_FLOOR) : searchRank;
    // A current provider designation wins over a generic Sleeper Active label.
    const statusSource = inactiveStatus(player) ? player : record || player;
    const mapped = {
      ...player, team, sleeperId: record?.player_id ?? null,
      status: statusSource.status ?? player.status,
      injuryStatus: statusSource.injuryStatus ?? statusSource.injury_status ?? player.injuryStatus,
      newsStatus: statusSource.newsStatus ?? statusSource.news_status ?? player.newsStatus,
      sleeperAdp, searchRank: effectiveSearchRank,
      adp: sleeperAdp ?? effectiveSearchRank ?? MISSING_MARKET_RANK
    };
    mapped.adp = marketRank(mapped);
    return mapped;
  });
}
