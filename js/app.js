/**
 * app.js
 * -----------------------------------------------------------------------------
 * Application shell: boots the engine, owns transient UI state (filters,
 * selections), wires every control, and repaints through uiRenderer.
 */

import { DraftEngine } from './draftEngine.js';
import {
  cacheDom,
  dom,
  renderAll,
  renderRosterSelect,
  toast
} from './uiRenderer.js';

/** Transient view state — never persisted into the draft itself. */
const ui = {
  search: '',
  position: 'ALL',
  sort: 'vor',
  hideDrafted: true,
  poolLimit: 120,
  selectedTeamId: 1,
  selectedPlayerId: null
};

const engine = new DraftEngine({ teamCount: 12, rounds: 15, userTeamId: 1 });

/** Guards the animated bot loop so two runs never overlap. */
let simulation = { running: false, cancel: false };

/* --------------------------------------------------------------------- boot */

function init() {
  cacheDom();
  renderRosterSelect(engine, ui);
  bindEvents();
  engine.on('change', () => renderAll(engine, ui));
  renderAll(engine, ui);
  toast('Draft room ready — 12 teams, 15 rounds, snake order.', 'info');
}

/* ------------------------------------------------------------------- events */

function bindEvents() {
  dom.playerSearch.addEventListener('input', (event) => {
    ui.search = event.target.value;
    renderAll(engine, ui);
  });

  dom.positionFilters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-position]');
    if (!button) return;
    ui.position = button.dataset.position;
    renderAll(engine, ui);
  });

  dom.sortSelect.addEventListener('change', (event) => {
    ui.sort = event.target.value;
    renderAll(engine, ui);
  });

  dom.hideDraftedWrap.addEventListener('change', (event) => {
    ui.hideDrafted = event.target.checked;
    renderAll(engine, ui);
  });

  dom.playerPool.addEventListener('click', (event) => {
    const row = event.target.closest('[data-player-id]');
    if (!row) return;
    selectPlayer(row.dataset.playerId);
  });

  dom.playerPool.addEventListener('dblclick', (event) => {
    const row = event.target.closest('[data-player-id]');
    if (!row) return;
    selectPlayer(row.dataset.playerId);
    makeUserPick();
  });

  dom.recommendations.addEventListener('click', (event) => {
    const row = event.target.closest('[data-player-id]');
    if (row) selectPlayer(row.dataset.playerId);
  });

  dom.draftBoard.addEventListener('click', (event) => {
    const cell = event.target.closest('[data-team-id]');
    if (!cell) return;
    ui.selectedTeamId = Number(cell.dataset.teamId);
    renderRosterSelect(engine, ui);
    renderAll(engine, ui);
  });

  dom.rosterTeamSelect.addEventListener('change', (event) => {
    ui.selectedTeamId = Number(event.target.value);
    renderAll(engine, ui);
  });

  dom.btnMakePick.addEventListener('click', makeUserPick);
  dom.btnAutoPick.addEventListener('click', () => {
    if (engine.complete) return;
    const pick = engine.autoPick();
    if (pick) announcePick(pick);
  });
  dom.btnSimRound.addEventListener('click', () => runSimulation({ mode: 'round' }));
  dom.btnSimToMe.addEventListener('click', () => runSimulation({ mode: 'toUser' }));

  dom.btnUndo.addEventListener('click', () => {
    simulation.cancel = true;
    const pick = engine.undo();
    if (pick) toast(`Undid pick ${pick.overall}.`, 'warn');
  });

  dom.btnReset.addEventListener('click', () => {
    simulation.cancel = true;
    engine.reset();
    ui.selectedPlayerId = null;
    ui.search = '';
    ui.position = 'ALL';
    dom.playerSearch.value = '';
    renderRosterSelect(engine, ui);
    renderAll(engine, ui);
    toast('Draft reset.', 'info');
  });

  dom.toggleAutoDraft.addEventListener('click', () => {
    engine.autoDraftUser = !engine.autoDraftUser;
    toast(
      engine.autoDraftUser
        ? 'Auto-draft ON — bots will pick for your team too.'
        : 'Auto-draft OFF — your picks are yours again.',
      engine.autoDraftUser ? 'warn' : 'info'
    );
    renderAll(engine, ui);
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) {
      if (event.key === 'Escape') event.target.blur();
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      dom.playerSearch.focus();
    } else if (event.key === 'Enter') {
      makeUserPick();
    } else if (event.key.toLowerCase() === 'u') {
      dom.btnUndo.click();
    } else if (event.key.toLowerCase() === 's') {
      runSimulation({ mode: 'round' });
    }
  });
}

/* ------------------------------------------------------------------ actions */

function selectPlayer(playerId) {
  const player = engine.playersById[playerId];
  if (!player || player.draftedBy !== null) return;
  ui.selectedPlayerId = playerId;
  renderAll(engine, ui);
}

function makeUserPick() {
  if (!engine.isUserOnClock) {
    toast('Not your pick yet — simulate ahead first.', 'warn');
    return;
  }
  if (!ui.selectedPlayerId) {
    toast('Select a player from the pool first.', 'warn');
    return;
  }
  try {
    const pick = engine.makePick(ui.selectedPlayerId);
    ui.selectedPlayerId = null;
    announcePick(pick);
    runSimulation({ mode: 'toUser' });
  } catch (error) {
    toast(error.message, 'error');
  }
}

/**
 * Animated bot run. `round` stops at the end of the current round, `toUser`
 * stops when the human is back on the clock.
 */
async function runSimulation({ mode = 'toUser', delay = 260 }) {
  if (simulation.running || engine.complete) return;
  simulation = { running: true, cancel: false };
  const startingRound = engine.currentRound;
  setControlsBusy(true);

  try {
    while (!engine.complete && !simulation.cancel) {
      if (engine.isUserOnClock && !engine.autoDraftUser) break;
      if (mode === 'round' && engine.currentRound !== startingRound) break;

      const pick = engine.autoPick();
      if (!pick) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  } finally {
    simulation.running = false;
    setControlsBusy(false);
    renderAll(engine, ui);
  }

  if (engine.complete) toast('Draft complete — review the final board.', 'success');
  else if (engine.isUserOnClock) toast("You're on the clock.", 'success');
}

function announcePick(pick) {
  const player = engine.playersById[pick.playerId];
  const team = engine.teams.find((t) => t.id === pick.teamId);
  toast(
    `${team.abbr} selects ${player.name} (${player.position} · ${player.team})`,
    team.isUser ? 'success' : 'info'
  );
}

function setControlsBusy(busy) {
  [dom.btnSimRound, dom.btnSimToMe, dom.btnAutoPick].forEach((button) => {
    button.disabled = busy || engine.complete;
    button.classList.toggle('is-busy', busy);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Exposed for console tinkering / integration tests.
window.FSN = { engine, ui };
