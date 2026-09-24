/**
 * vorMath.js
 * -----------------------------------------------------------------------------
 * Value Over Replacement (VOR) engine.
 *
 * VOR answers "how many more points does this player score than the guy I could
 * grab off waivers at the same position?". It is the cleanest way to compare a
 * 300-point QB against a 220-point RB in a single-number ranking.
 *
 *   VOR(player) = projection(player) - projection(replacementPlayerAtPosition)
 *
 * The replacement player is the Nth best at a position, where N is how many of
 * that position the league is expected to start across all teams.
 */

import { POSITIONS } from './types.js';

/**
 * How many players at each position are expected to be "startable" in a league
 * of `teamCount` franchises. Multipliers account for flex usage and byes.
 * @param {number} teamCount
 * @returns {Record<string, number>}
 */
export function replacementRanks(teamCount = 12) {
  return {
    QB: Math.round(teamCount * 1.2),
    RB: Math.round(teamCount * 2.5),
    WR: Math.round(teamCount * 3.0),
    TE: Math.round(teamCount * 1.2),
    K: teamCount,
    DST: teamCount
  };
}

/**
 * Positional bumps applied when deriving ADP only. VOR itself stays pure;
 * these model real drafter behaviour (nobody takes a kicker in round 3).
 */
const ADP_BIAS = { QB: -18, RB: 12, WR: 6, TE: 0, K: -140, DST: -120 };

/**
 * Computes the replacement-level projection for every position.
 * @param {import('./types.js').Player[]} players
 * @param {number} teamCount
 * @returns {Record<string, {rank: number, projection: number, name: string}>}
 */
export function calculateReplacementLevels(players, teamCount = 12) {
  const ranks = replacementRanks(teamCount);
  /** @type {Record<string, {rank: number, projection: number, name: string}>} */
  const levels = {};

  POSITIONS.forEach((position) => {
    const pool = players
      .filter((p) => p.position === position)
      .sort((a, b) => b.projection - a.projection);

    if (pool.length === 0) {
      levels[position] = { rank: 0, projection: 0, name: '—' };
      return;
    }

    const index = Math.min(ranks[position], pool.length) - 1;
    const replacement = pool[Math.max(0, index)];
    levels[position] = {
      rank: index + 1,
      projection: replacement.projection,
      name: replacement.name
    };
  });

  return levels;
}

/**
 * Splits a position group into tiers by looking for meaningful scoring cliffs.
 * @param {import('./types.js').Player[]} sortedGroup Descending by projection.
 * @returns {number[]} tier number per index
 */
function assignTiers(sortedGroup) {
  if (sortedGroup.length === 0) return [];
  const gaps = [];
  for (let i = 1; i < sortedGroup.length; i += 1) {
    gaps.push(sortedGroup[i - 1].projection - sortedGroup[i].projection);
  }
  const meanGap = gaps.reduce((sum, g) => sum + g, 0) / (gaps.length || 1);
  const threshold = Math.max(10, meanGap * 2.2);

  const tiers = [1];
  let tier = 1;
  for (let i = 0; i < gaps.length; i += 1) {
    if (gaps[i] >= threshold) tier += 1;
    tiers.push(tier);
  }
  return tiers;
}

/**
 * Enriches every player in place with vor, vorRank, posRank, tier and adp.
 * Returns the same array for convenient chaining.
 *
 * @param {import('./types.js').Player[]} players
 * @param {number} teamCount
 * @returns {import('./types.js').Player[]}
 */
export function enrichPlayers(players, teamCount = 12) {
  const levels = calculateReplacementLevels(players, teamCount);

  POSITIONS.forEach((position) => {
    const group = players
      .filter((p) => p.position === position)
      .sort((a, b) => b.projection - a.projection);

    const tiers = assignTiers(group);
    group.forEach((player, index) => {
      player.vor = round1(player.projection - levels[position].projection);
      player.posRank = index + 1;
      player.tier = tiers[index] || 1;
    });
  });

  // Overall VOR ranking (pure value, no positional bias).
  [...players]
    .sort((a, b) => b.vor - a.vor)
    .forEach((player, index) => {
      player.vorRank = index + 1;
    });

  // Derived ADP: VOR plus drafter-behaviour bias, then ranked.
  [...players]
    .sort((a, b) => draftValue(b) - draftValue(a))
    .forEach((player, index) => {
      player.adp = index + 1;
    });

  return players;
}

/**
 * Board value used for ADP and bot preference: VOR shaped by drafter habits.
 * @param {import('./types.js').Player} player
 */
export function draftValue(player) {
  return player.vor + (ADP_BIAS[player.position] || 0);
}

/**
 * Remaining value at each position — the scarcity read shown in the sidebar.
 * @param {import('./types.js').Player[]} available
 * @returns {Array<{position: string, count: number, topVor: number, depthToReplacement: number}>}
 */
export function positionalScarcity(available) {
  return POSITIONS.map((position) => {
    const pool = available
      .filter((p) => p.position === position)
      .sort((a, b) => b.vor - a.vor);
    return {
      position,
      count: pool.length,
      topVor: pool.length ? pool[0].vor : 0,
      depthToReplacement: pool.filter((p) => p.vor > 0).length
    };
  });
}

/**
 * Ranks available players for a specific roster, blending raw VOR with how
 * badly the roster needs the position and how soon the next pick comes back.
 *
 * @param {import('./types.js').Player[]} available
 * @param {Record<string, number>} needWeights position -> multiplier bonus
 * @param {number} limit
 */
export function recommendPlayers(available, needWeights = {}, limit = 5) {
  return [...available]
    .map((player) => ({
      player,
      score: round1(player.vor + (needWeights[player.position] || 0))
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Value left on the board relative to the best player available — used for the
 * "reach / value" tag in the pick ticker.
 * @param {import('./types.js').Player} player
 * @param {number} overallPick
 */
export function valueDelta(player, overallPick) {
  return player.adp - overallPick;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
