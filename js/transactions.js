/**
 * transactions.js
 * -----------------------------------------------------------------------------
 * The waiver wire and the trade engine, as the pure functions every layer
 * shares: how a sealed-bid board is ordered, how it settles, what makes a trade
 * legal, and which players in one are frozen by a game that has already
 * started.
 *
 * It exists for the same reason js/gameLock.js does. The real engine is in
 * Postgres — `fsnv2_process_waivers` and `fsnv2_execute_trade` in
 * supabase/migrations/0014_fsnv2_waivers_and_trades.sql settle the auction and
 * move the rosters, because that is the only place a transaction can hold the
 * whole league still. But three other layers need the same answers:
 *
 *   browser UI      "where does my claim sit, and would it go through?"
 *   API routes      a clean 400 before a mutation RPC is attempted
 *   test suite      the ordering and the outcomes, with no database
 *
 * and a second implementation of those rules is a second implementation that
 * drifts. So the rules live here once, and the SQL is commented as the mirror
 * it is. `tests/transactions.test.mjs` holds this file to the ordering
 * `fsnv2_waiver_board` produces and to the outcomes
 * `fsnv2.process_league_waivers` produces;
 * supabase/tests/0014_waivers_and_trades.test.sql holds the database to the
 * same cases.
 *
 * Nothing here reads the network or the clock unless it is handed one. Every
 * function takes plain objects and tolerates either spelling of a field —
 * `bid_amount` from PostgREST, `bidAmount` from the browser — because the same
 * row arrives from both.
 */

import { isPlayerLocked, playerLockState, playerName } from './gameLock.js';

/* ------------------------------------------------------------------ shapes */

/** The five outcomes a bid can end in. Mirrors the check on `waiver_bids.status`. */
export const WAIVER_BID_STATUSES = [
  'PENDING',
  'SUCCESSFUL',
  'FAILED_INSUFFICIENT_FAAB',
  'FAILED_PLAYER_TAKEN',
  'CANCELLED'
];

/**
 * Trade statuses. PENDING_NEXT_WEEK is the deferral: a trade whose players were
 * mid-game when it was executed, waiting for the week to turn.
 */
export const TRADE_STATUSES = [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'CANCELLED',
  'EXECUTED',
  'VETOED',
  'PENDING_NEXT_WEEK'
];

export const TRADE_ASSET_TYPES = ['PLAYER', 'FAAB', 'DRAFT_PICK'];

/** The 15 lineup slots, in the order `fsnv2_lineup_state` fills them. */
export const ROSTER_SLOTS = ['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLEX', 'DST', 'K',
  'BN1', 'BN2', 'BN3', 'BN4', 'BN5', 'BN6'];

/** First present key, so a row from PostgREST and one from the UI both read. */
function pick(row, ...keys) {
  if (!row || typeof row !== 'object') return undefined;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return undefined;
}

function num(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** An epoch for ordering — a bid's created_at, however it was serialised. */
function at(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/**
 * One bid, in the shape the rest of this file uses.
 *
 * @typedef {Object} WaiverBid
 * @property {string} bidId
 * @property {number} teamId
 * @property {string} playerId        the claim
 * @property {string|null} dropPlayerId
 * @property {number} bidAmount       FAAB dollars
 * @property {number} priority        the team's own ranking of its own bids
 * @property {number} waiverPriority  the league's rolling order (1 picks first)
 * @property {number} createdAt       epoch millis
 */

/**
 * @param {Record<string, any>} row
 * @returns {WaiverBid}
 */
export function normalizeBid(row) {
  return {
    bidId: pick(row, 'bidId', 'bid_id', 'id') ?? null,
    teamId: num(pick(row, 'teamId', 'team_id'), 0),
    playerId: pick(row, 'playerId', 'player_id') ?? null,
    dropPlayerId: pick(row, 'dropPlayerId', 'drop_player_id') ?? null,
    bidAmount: num(pick(row, 'bidAmount', 'bid_amount'), 0),
    priority: num(pick(row, 'priority'), 1),
    // A team with no waiver-state row yet sits at its slot number, which is
    // what `fsnv2_waiver_board` coalesces to.
    waiverPriority: num(
      pick(row, 'waiverPriority', 'waiver_priority') ?? pick(row, 'teamId', 'team_id'),
      Number.MAX_SAFE_INTEGER
    ),
    createdAt: at(pick(row, 'createdAt', 'created_at'))
  };
}

/* ------------------------------------------------------------- the ordering */

/**
 * The processing order, which is the auction:
 *
 *   bid_amount      desc    the money
 *   waiver_priority asc     the league's rolling list breaks a tie on money
 *   created_at      asc     the earlier bid breaks a tie on both
 *   priority        asc     then the team's own ranking of its own bids
 *   bidId           asc     and the id, so the order is total and stable
 *
 * Mirrors the `order by` in `fsnv2_waiver_board` and in
 * `fsnv2.process_league_waivers`. The last two keys matter less than they look:
 * they exist so that two runs over the same board — one in Postgres, one here —
 * can never disagree, which is what makes the UI's preview trustworthy.
 *
 * @param {Array<Record<string, any>>} bids
 * @returns {WaiverBid[]} a new array; the input is left alone
 */
export function sortWaiverBids(bids) {
  return (Array.isArray(bids) ? bids : [])
    .map(normalizeBid)
    .sort(
      (a, b) =>
        b.bidAmount - a.bidAmount ||
        a.waiverPriority - b.waiverPriority ||
        a.createdAt - b.createdAt ||
        a.priority - b.priority ||
        String(a.bidId).localeCompare(String(b.bidId))
    );
}

/* -------------------------------------------------------------- the outcome */

/**
 * What a waiver run would do to this board.
 *
 * A faithful mirror of the loop in `fsnv2.process_league_waivers`: one pass in
 * processing order, re-reading the budget and the roster at every step, so the
 * second claim a team wins is checked against the money the first one spent.
 * The two failures the status column has no code of its own for — a drop player
 * a winning claim already consumed, and a full roster with no drop named — come
 * back as FAILED_PLAYER_TAKEN with a `detail`, exactly as the database records
 * them.
 *
 * It changes nothing. The UI uses it to tell a manager their $40 second claim
 * cannot be paid for; the processing itself happens in one Postgres
 * transaction, because only that can hold every roster in the league still
 * while the board is settled.
 *
 * @param {Array<Record<string, any>>} bids
 * @param {Object} state
 * @param {Record<number, number>} state.budgets        team id -> FAAB left
 * @param {Record<number, number>} state.rosterSizes    team id -> players held
 * @param {Record<string, number>} [state.ownedBy]      player id -> team id
 * @param {number} [state.capacity]                     roster limit (default 15)
 * @param {Set<string>|string[]} [state.lockedPlayerIds] players whose game has started
 * @returns {{outcomes: Array<{bidId: string, teamId: number, playerId: string,
 *            status: string, detail: string|null}>, awarded: string[],
 *            budgets: Record<number, number>}}
 */
export function resolveWaiverBoard(bids, state = {}) {
  const capacity = Number.isInteger(state.capacity) ? state.capacity : 15;
  const budgets = { ...(state.budgets ?? {}) };
  const sizes = { ...(state.rosterSizes ?? {}) };
  const ownedBy = { ...(state.ownedBy ?? {}) };
  const locked = new Set(state.lockedPlayerIds ?? []);

  const outcomes = [];
  const awarded = [];
  const resolved = new Set();

  for (const bid of sortWaiverBids(bids)) {
    if (resolved.has(bid.bidId)) continue;

    const budget = num(budgets[bid.teamId], 0);
    const size = num(sizes[bid.teamId], 0);
    let status = null;
    let detail = null;

    if (ownedBy[bid.playerId] !== undefined) {
      status = 'FAILED_PLAYER_TAKEN';
      detail = `${bid.playerId} was already on a roster.`;
    } else if (bid.bidAmount > budget) {
      status = 'FAILED_INSUFFICIENT_FAAB';
      detail = `The bid of $${bid.bidAmount} was more than the $${budget} left in the budget.`;
    } else if (bid.dropPlayerId && ownedBy[bid.dropPlayerId] !== bid.teamId) {
      status = 'FAILED_PLAYER_TAKEN';
      detail = `${bid.dropPlayerId} had already left the roster.`;
    } else if (bid.dropPlayerId && locked.has(bid.dropPlayerId)) {
      status = 'FAILED_PLAYER_TAKEN';
      detail = `${bid.dropPlayerId} is locked because their game has already started.`;
    } else if (!bid.dropPlayerId && size >= capacity) {
      status = 'FAILED_PLAYER_TAKEN';
      detail = 'The roster was full and the bid named no player to drop.';
    }

    if (status) {
      outcomes.push({ ...bidRef(bid), status, detail });
      resolved.add(bid.bidId);
      continue;
    }

    // The award, and everything it invalidates.
    budgets[bid.teamId] = budget - bid.bidAmount;
    ownedBy[bid.playerId] = bid.teamId;
    if (bid.dropPlayerId) delete ownedBy[bid.dropPlayerId];
    sizes[bid.teamId] = size + (bid.dropPlayerId ? 0 : 1);

    outcomes.push({ ...bidRef(bid), status: 'SUCCESSFUL', detail: `Awarded for $${bid.bidAmount}.` });
    awarded.push(bid.playerId);
    resolved.add(bid.bidId);
  }

  return { outcomes, awarded, budgets, rosterSizes: sizes, ownedBy };
}

function bidRef(bid) {
  return {
    bidId: bid.bidId,
    teamId: bid.teamId,
    playerId: bid.playerId,
    dropPlayerId: bid.dropPlayerId,
    bidAmount: bid.bidAmount
  };
}

/* ---------------------------------------------------------------- the trade */

/**
 * One asset in a trade.
 *
 * @typedef {Object} TradeItem
 * @property {number} senderTeamId
 * @property {'PLAYER'|'FAAB'|'DRAFT_PICK'} assetType
 * @property {string|null} assetId
 * @property {number|null} amount
 */

/**
 * The items as `fsnv2_propose_trade` wants them: snake_case keys, uppercase
 * asset types, nothing undefined. Throws a TypeError naming the offending item
 * rather than letting a malformed asset reach the database as a constraint
 * violation — a 400 that says "item 2 has no asset_id" is worth more to a
 * client than Postgres's own wording.
 *
 * @param {unknown} items
 * @returns {TradeItem[]}
 */
export function normalizeTradeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new TypeError('A trade has to move at least one asset.');
  }

  return items.map((raw, index) => {
    const label = `item ${index + 1}`;
    if (!raw || typeof raw !== 'object') throw new TypeError(`${label} is not an asset.`);

    const senderTeamId = Number(pick(raw, 'senderTeamId', 'sender_team_id'));
    const assetType = String(pick(raw, 'assetType', 'asset_type') ?? '').toUpperCase();
    const assetId = pick(raw, 'assetId', 'asset_id') ?? null;
    const amountRaw = pick(raw, 'amount');
    const amount = amountRaw === undefined ? null : num(amountRaw, Number.NaN);

    if (!Number.isInteger(senderTeamId) || senderTeamId < 1) {
      throw new TypeError(`${label} does not say which team is sending it.`);
    }
    if (!TRADE_ASSET_TYPES.includes(assetType)) {
      throw new TypeError(
        `${label} has asset type "${assetType || '(none)'}" — expected PLAYER, FAAB or DRAFT_PICK.`
      );
    }
    if (assetType !== 'FAAB' && (typeof assetId !== 'string' || assetId === '')) {
      throw new TypeError(`${label} is a ${assetType} with no asset id.`);
    }
    if (assetType === 'FAAB' && !(Number.isFinite(amount) && amount > 0)) {
      throw new TypeError(`${label} sends FAAB but no positive amount.`);
    }

    return {
      sender_team_id: senderTeamId,
      asset_type: assetType,
      asset_id: assetType === 'FAAB' ? null : assetId,
      amount: assetType === 'FAAB' ? amount : null
    };
  });
}

/** The player ids a trade would move, in the order they appear. */
export function tradePlayerIds(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => String(pick(item, 'assetType', 'asset_type') ?? '').toUpperCase() === 'PLAYER')
    .map((item) => pick(item, 'assetId', 'asset_id'))
    .filter((id) => typeof id === 'string' && id !== '');
}

/**
 * Is this trade legal, before anyone is asked to accept it?
 *
 * The same four questions `fsnv2.assert_trade_valid` asks: does every sender
 * belong to the trade, does each own what they are sending, can both rosters
 * hold what they are receiving, and can each cover the FAAB it is sending.
 * Returns the reasons rather than throwing, because a proposal form wants to
 * show all of them at once.
 *
 * @param {Object} input
 * @param {Array<Record<string, any>>} input.items
 * @param {number} input.proposerTeamId
 * @param {number} input.recipientTeamId
 * @param {Record<string, number>} input.ownedBy    player id -> team id
 * @param {Record<number, number>} input.rosterSizes
 * @param {Record<number, number>} [input.budgets]
 * @param {number} [input.capacity]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateTradeProposal({
  items,
  proposerTeamId,
  recipientTeamId,
  ownedBy = {},
  rosterSizes = {},
  budgets = {},
  capacity = 15
} = {}) {
  const errors = [];
  if (proposerTeamId === recipientTeamId) errors.push('A team cannot trade with itself.');

  let normalized = [];
  try {
    normalized = normalizeTradeItems(items);
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }

  const sides = [proposerTeamId, recipientTeamId];
  normalized.forEach((item, index) => {
    if (!sides.includes(item.sender_team_id)) {
      errors.push(`Item ${index + 1} is sent by team ${item.sender_team_id}, which is not in this trade.`);
    }
    if (item.asset_type === 'PLAYER' && ownedBy[item.asset_id] !== item.sender_team_id) {
      errors.push(`${item.asset_id} is not on team ${item.sender_team_id}'s roster.`);
    }
  });

  sides.forEach((team) => {
    const sent = normalized.filter((i) => i.asset_type === 'PLAYER' && i.sender_team_id === team).length;
    const received = normalized.filter(
      (i) => i.asset_type === 'PLAYER' && i.sender_team_id !== team
    ).length;
    const size = num(rosterSizes[team], 0);
    if (size - sent + received > capacity) {
      errors.push(
        `Team ${team} would be left with ${size - sent + received} players, over the limit of ${capacity}.`
      );
    }

    const owed = normalized
      .filter((i) => i.asset_type === 'FAAB' && i.sender_team_id === team)
      .reduce((sum, i) => sum + num(i.amount), 0);
    if (owed > 0 && owed > num(budgets[team], 0)) {
      errors.push(`Team ${team} cannot send $${owed} of FAAB — only $${num(budgets[team], 0)} is left.`);
    }
  });

  return { ok: errors.length === 0, errors };
}

/* ----------------------------------------------------------------- the lock */

/**
 * Which players in a trade are in a game that has already started.
 *
 * This is requirement 3's guard, in the browser and in the API route:
 * `isPlayerLocked()` re-run over the whole trade payload rather than the two
 * sides of a lineup swap. A trade with any locked player is not refused — it is
 * deferred, and `fsnv2_execute_trade` is what marks it PENDING_NEXT_WEEK. What
 * this function buys is the explanation, before the mutation is attempted.
 *
 * @param {Array<Record<string, any>>} items
 * @param {Record<string, Record<string, any>>} playersById
 * @param {unknown} gameSchedule a week's games (any shape gameLock reads)
 * @param {number} [now] epoch millis
 * @returns {Array<{playerId: string, name: string, team: string|null,
 *                  reason: string, kickoff: number|null}>}
 */
export function lockedTradePlayers(items, playersById, gameSchedule, now = Date.now()) {
  return tradePlayerIds(items)
    .map((playerId) => ({ playerId, player: playersById?.[playerId] ?? null }))
    .filter(({ player }) => player && isPlayerLocked(player, gameSchedule, now))
    .map(({ playerId, player }) => {
      const state = playerLockState(player, gameSchedule, now);
      return {
        playerId,
        name: playerName(player),
        team: state.team,
        reason: state.reason,
        kickoff: state.kickoff
      };
    });
}

/**
 * The sentence a manager reads when a trade is held over. One wording, the way
 * `lockedPlayerMessage()` is one wording for a refused swap — and the same one
 * `fsnv2_execute_trade` writes into `trades.status_detail`.
 *
 * @param {Array<{name: string}>} locked
 * @param {number} effectiveWeek
 */
export function tradeDeferralMessage(locked, effectiveWeek) {
  const [first, ...rest] = locked ?? [];
  if (!first) return '';
  const who =
    rest.length === 0
      ? `${first.name} is`
      : `${first.name} and ${rest.length} other player(s) are`;
  return `${who} in a game that has already started; the trade takes effect in week ${effectiveWeek}.`;
}

/** True when a trade cannot be executed now and has to wait for the week to turn. */
export function tradeMustWait(items, playersById, gameSchedule, now = Date.now()) {
  return lockedTradePlayers(items, playersById, gameSchedule, now).length > 0;
}
