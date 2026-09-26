/**
 * lineup.js
 * -----------------------------------------------------------------------------
 * Picking a slot, swapping two players, and putting the lineup back when the
 * save is refused.
 *
 * A swap is only offered while both players are still movable. A player whose
 * NFL game has kicked off is frozen for the week — otherwise a manager could
 * watch Thursday night and only then decide to start (or bench) the player who
 * produced it. `js/gameLock.js` owns that rule; this module asks it before it
 * offers a slot as a target and again before it applies the swap, and
 * `fsnv2_swap_lineup` re-checks it inside the write so a stale tab (or a
 * hand-rolled call) cannot get past it either.
 */

import { isLockedInWeek, lockedPlayerMessage } from './gameLock.js';
import { getCurrentNFLWeek } from './nflWeek.js';
import { ROSTER_SLOTS } from './types.js';

const slotsByKey = new Map(ROSTER_SLOTS.map((slot) => [slot.key, slot]));

/**
 * The player in a slot, when their game has already started.
 *
 * @param {Record<string, string|null>} roster
 * @param {Record<string, Object>} playersById
 * @param {string} slotKey
 * @param {number} week
 * @param {number} [now]
 * @returns {Object|null} the locked player, or null when the slot is movable
 */
export function lockedPlayerIn(roster, playersById, slotKey, week, now = Date.now()) {
  const player = roster?.[slotKey] ? playersById[roster[slotKey]] : null;
  return player && isLockedInWeek(player, week, now) ? player : null;
}

/**
 * The locked player standing in the way of a swap, checking **both** slots: the
 * one moving into the lineup and the one moving out. Checking only the incoming
 * player is the hole that lets a manager bench someone at halftime.
 *
 * @returns {Object|null}
 */
export function lockedInSwap(roster, playersById, from, to, week, now = Date.now()) {
  return (
    lockedPlayerIn(roster, playersById, from, week, now) ??
    lockedPlayerIn(roster, playersById, to, week, now)
  );
}

/**
 * Is this swap legal *right now*? Positional eligibility, plus the lock: a week
 * is passed when the caller knows which one is on screen, and a locked player on
 * either side makes the answer no.
 *
 * @param {number} [week] the NFL week the lineup is being set for
 * @param {number} [now] epoch millis — injectable so tests and the API agree
 */
export function canSwap(roster, playersById, from, to, week = null, now = Date.now()) {
  const source = slotsByKey.get(from);
  const destination = slotsByKey.get(to);
  if (!source || !destination || from === to || !roster[from]) return false;
  const first = playersById[roster[from]];
  const second = roster[to] ? playersById[roster[to]] : null;
  if (!first || !destination.accepts.includes(first.position)) return false;
  if (second && !source.accepts.includes(second.position)) return false;
  return week === null || !lockedInSwap(roster, playersById, from, to, week, now);
}

export function swapRoster(roster, from, to) {
  return { ...roster, [from]: roster[to], [to]: roster[from] };
}

export function validLineup(roster, playersById, playerIds) {
  if (!roster || Object.keys(roster).length !== ROSTER_SLOTS.length) return false;
  const ids = ROSTER_SLOTS.map((slot) => {
    const id = roster[slot.key];
    if (id === null) return null;
    const player = playersById[id];
    return player && slot.accepts.includes(player.position) ? id : undefined;
  });
  return !ids.includes(undefined) &&
    ids.filter(Boolean).sort().join('\0') === [...playerIds].sort().join('\0');
}

/**
 * The static app's stateful equivalent of a useLineup hook.
 *
 * @param {Object} options
 * @param {() => number} [options.week] the week the lineup is being set for —
 *   the Team view's own selector, so the locks follow what is on screen.
 * @param {() => number} [options.now] injectable clock, for tests
 */
export function createLineup({
  engine,
  teamId,
  persist,
  notify,
  onChange,
  week = () => getCurrentNFLWeek(),
  now = () => Date.now()
}) {
  let selectedPlayerId = null;
  let selectedSlot = null;
  let pending = false;
  let version = 0;

  /** The player in this slot if their game has started, else null. */
  function lockedIn(slotKey) {
    return lockedPlayerIn(engine.rosterFor(teamId), engine.playersById, slotKey, week(), now());
  }

  function clear() {
    selectedPlayerId = null;
    selectedSlot = null;
    onChange();
  }

  function select(slotKey) {
    if (pending || teamId !== engine.userTeamId) return;
    const roster = engine.rosterFor(teamId);
    if (!ROSTER_SLOTS.some((slot) => slot.key === slotKey)) return;

    // A locked player is neither something to pick up nor somewhere to put
    // someone: their week is already being played. Saying so is part of the
    // refusal — a row that silently ignores a click looks like a bug.
    const locked = lockedIn(slotKey);
    if (locked) {
      notify(lockedPlayerMessage(locked), 'warn');
      onChange(slotKey);
      return;
    }

    if (!selectedSlot) {
      if (!roster[slotKey]) return;
      selectedSlot = slotKey;
      selectedPlayerId = roster[slotKey];
      onChange();
      return;
    }
    if (selectedSlot === slotKey) return clear();
    // Re-checked against the clock here, not just at selection time: a game can
    // kick off between picking a player up and putting them down.
    const blocked = lockedInSwap(roster, engine.playersById, selectedSlot, slotKey, week(), now());
    if (blocked) {
      notify(lockedPlayerMessage(blocked), 'warn');
      onChange(slotKey);
      return;
    }
    if (!canSwap(roster, engine.playersById, selectedSlot, slotKey)) {
      notify('That player cannot play in the selected slot.', 'warn');
      onChange(slotKey);
      return;
    }

    const from = selectedSlot;
    const before = { ...roster };
    const fromPlayerId = roster[from];
    const toPlayerId = roster[slotKey];
    const expectedVersion = version;
    selectedSlot = null;
    selectedPlayerId = null;
    pending = true;
    engine.setLineup(teamId, swapRoster(roster, from, slotKey));
    onChange();
    Promise.resolve().then(() => persist({ from, to: slotKey, fromPlayerId, toPlayerId, expectedVersion }))
      .then((result) => {
        if (result?.roster) {
          if (!engine.setLineup(teamId, result.roster)) throw new Error('Saved lineup differs from the draft.');
          version = result.version;
        }
        notify('Lineup updated.', 'success');
      })
      .catch((error) => {
        engine.setLineup(teamId, before);
        notify(`Lineup could not be saved: ${error.message}`, 'warn');
      })
      .finally(() => { pending = false; onChange(); });
  }

  return {
    select, clear,
    get selectedPlayerId() { return selectedPlayerId; },
    get selectedSlot() { return selectedSlot; },
    get pending() { return pending; },
    /** True when this slot's player is frozen for the week — the 🔒 rows. */
    lockedSlot: (slotKey) => Boolean(lockedIn(slotKey)),
    lockedPlayer: lockedIn,
    validTarget: (slotKey) => selectedSlot !== null &&
      canSwap(engine.rosterFor(teamId), engine.playersById, selectedSlot, slotKey, week(), now()),
    hydrate(roster, nextVersion = 0) {
      if (engine.setLineup(teamId, roster)) {
        version = nextVersion;
        clear();
        return true;
      }
      return false;
    }
  };
}
