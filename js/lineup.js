import { ROSTER_SLOTS } from './types.js';

const slotsByKey = new Map(ROSTER_SLOTS.map((slot) => [slot.key, slot]));

export function canSwap(roster, playersById, from, to) {
  const source = slotsByKey.get(from);
  const destination = slotsByKey.get(to);
  if (!source || !destination || from === to || !roster[from]) return false;
  const first = playersById[roster[from]];
  const second = roster[to] ? playersById[roster[to]] : null;
  return Boolean(first && destination.accepts.includes(first.position) &&
    (!second || source.accepts.includes(second.position)));
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

/** The static app's stateful equivalent of a useLineup hook. */
export function createLineup({ engine, teamId, persist, notify, onChange }) {
  let selectedPlayerId = null;
  let selectedSlot = null;
  let pending = false;
  let version = 0;

  function clear() {
    selectedPlayerId = null;
    selectedSlot = null;
    onChange();
  }

  function select(slotKey) {
    if (pending || teamId !== engine.userTeamId) return;
    const roster = engine.rosterFor(teamId);
    if (!ROSTER_SLOTS.some((slot) => slot.key === slotKey)) return;
    if (!selectedSlot) {
      if (!roster[slotKey]) return;
      selectedSlot = slotKey;
      selectedPlayerId = roster[slotKey];
      onChange();
      return;
    }
    if (selectedSlot === slotKey) return clear();
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
    validTarget: (slotKey) => selectedSlot !== null &&
      canSwap(engine.rosterFor(teamId), engine.playersById, selectedSlot, slotKey),
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
