/**
 * uiRenderer.js
 * -----------------------------------------------------------------------------
 * Pure-ish DOM rendering layer. Every function takes the engine plus the UI
 * state object and rewrites a single region of the page, so the view is always
 * a function of state and never drifts out of sync with the draft.
 */

import { POSITIONS, ROSTER_SLOTS } from './types.js';
import { positionalScarcity } from './vorMath.js';

/** Cached element lookups. */
export const dom = {};

/** Grab every element the renderer touches, once. */
export function cacheDom() {
  const ids = [
    'onClockTeam', 'onClockMeta', 'roundLabel', 'pickLabel', 'progressBar', 'progressText',
    'draftBoard', 'playerPool', 'poolCount', 'playerSearch', 'positionFilters', 'sortSelect',
    'rosterTeamSelect', 'rosterSlots', 'rosterNeeds', 'recommendations', 'recentPicks',
    'selectionName', 'selectionMeta', 'btnMakePick', 'btnAutoPick', 'btnSimRound',
    'btnSimToMe', 'btnUndo', 'btnReset', 'toggleAutoDraft', 'toast', 'scarcityList',
    'hideDraftedWrap', 'boardStatus', 'clockEyebrow'
  ];
  ids.forEach((id) => {
    dom[id] = document.getElementById(id);
  });
  return dom;
}

/** Re-scan the document for Lucide icon placeholders. */
export function refreshIcons() {
  if (window.lucide?.createIcons) window.lucide.createIcons();
}

/* ------------------------------------------------------------------ header */

export function renderHeader(engine, ui) {
  const team = engine.teams.find((t) => t.id === engine.currentTeamId);
  const userTeam = engine.teams.find((t) => t.id === engine.userTeamId);
  const picksAway = engine.picksUntilTurn(engine.userTeamId);

  dom.onClockTeam.textContent = engine.complete ? 'Draft Complete' : team.name;
  dom.clockEyebrow.hidden = engine.complete;
  dom.onClockTeam.classList.toggle('text-brand-400', !engine.complete && team.isUser);

  if (engine.complete) {
    dom.onClockMeta.textContent = `All ${engine.totalPicks} picks are in — rosters are final.`;
  } else if (team.isUser) {
    dom.onClockMeta.textContent = 'You are on the clock. Pick a player from the pool.';
  } else {
    dom.onClockMeta.textContent =
      picksAway === Infinity
        ? `${userTeam.name} has no picks remaining.`
        : `${userTeam.name} is back up in ${picksAway} pick${picksAway === 1 ? '' : 's'}.`;
  }

  dom.roundLabel.textContent = `${engine.currentRound}`;
  dom.pickLabel.textContent = `${engine.currentPick}`;

  const pct = Math.round((engine.picks.length / engine.totalPicks) * 100);
  dom.progressBar.style.width = `${pct}%`;
  dom.progressText.textContent = `${engine.picks.length} / ${engine.totalPicks} picks · ${pct}%`;

  dom.btnMakePick.disabled = !engine.isUserOnClock || !ui.selectedPlayerId;
  dom.btnUndo.disabled = engine.picks.length === 0;
  dom.btnAutoPick.disabled = engine.complete;
  dom.btnSimRound.disabled = engine.complete;
  dom.btnSimToMe.disabled = engine.complete;
  dom.toggleAutoDraft.setAttribute('aria-pressed', String(engine.autoDraftUser));
  dom.toggleAutoDraft.classList.toggle('is-active', engine.autoDraftUser);
}

/* -------------------------------------------------------------- draft board */

export function renderBoard(engine, ui) {
  const { teamCount, rounds } = engine;
  const frag = document.createDocumentFragment();

  frag.appendChild(boardCell('corner', 'RND'));
  engine.teams.forEach((team) => {
    const cell = boardCell('board-head', '');
    cell.classList.toggle('is-user', team.isUser);
    cell.classList.toggle('is-selected', team.id === ui.selectedTeamId);
    cell.dataset.teamId = String(team.id);
    cell.innerHTML = `
      <span class="board-head__abbr">${team.abbr}</span>
      <span class="board-head__name">${escapeHtml(team.name)}</span>`;
    frag.appendChild(cell);
  });

  for (let round = 1; round <= rounds; round += 1) {
    const label = boardCell('board-round', `R${round}`);
    frag.appendChild(label);

    for (let slot = 1; slot <= teamCount; slot += 1) {
      const overall = (round - 1) * teamCount + slot;
      const teamId = engine.teamIdForPick(overall);
      const pick = engine.pickAt(round, slot);
      const cell = boardCell('board-cell', '');
      cell.dataset.teamId = String(teamId);
      cell.dataset.overall = String(overall);
      cell.classList.toggle('is-selected-team', teamId === ui.selectedTeamId);
      cell.classList.toggle('is-user-team', teamId === engine.userTeamId);

      if (pick) {
        const player = engine.playersById[pick.playerId];
        cell.classList.add('is-filled', `pos-${player.position.toLowerCase()}`);
        cell.innerHTML = `
          <span class="board-cell__meta">${overall}.${pick.auto ? ' AUTO' : ''}</span>
          <span class="board-cell__name">${escapeHtml(shortName(player.name))}</span>
          <span class="board-cell__pos">${player.position} · ${player.team}</span>`;
      } else if (overall === engine.currentPick && !engine.complete) {
        cell.classList.add('is-onclock');
        cell.innerHTML = `
          <span class="board-cell__meta">${overall}</span>
          <span class="board-cell__name">ON THE CLOCK</span>
          <span class="board-cell__pos">${engine.teams.find((t) => t.id === teamId).abbr}</span>`;
      } else {
        cell.innerHTML = `<span class="board-cell__meta">${overall}</span>`;
      }
      frag.appendChild(cell);
    }
  }

  dom.draftBoard.style.setProperty('--team-count', String(teamCount));
  dom.draftBoard.replaceChildren(frag);
  dom.boardStatus.textContent = engine.complete
    ? 'Final board'
    : `Round ${engine.currentRound} of ${rounds}`;
}

function boardCell(className, text) {
  const el = document.createElement('div');
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

/* -------------------------------------------------------------- player pool */

export function filterPool(engine, ui) {
  const query = ui.search.trim().toLowerCase();
  let players = Object.values(engine.playersById);

  if (ui.hideDrafted) players = players.filter((p) => p.draftedBy === null);
  if (ui.position === 'FLEX') players = players.filter((p) => ['RB', 'WR', 'TE'].includes(p.position));
  else if (ui.position !== 'ALL') players = players.filter((p) => p.position === ui.position);

  if (query) {
    players = players.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.team.toLowerCase().includes(query) ||
        p.position.toLowerCase() === query
    );
  }

  const sorters = {
    vor: (a, b) => b.vor - a.vor,
    adp: (a, b) => a.adp - b.adp,
    projection: (a, b) => b.projection - a.projection,
    name: (a, b) => a.name.localeCompare(b.name)
  };
  return players.sort(sorters[ui.sort] || sorters.vor);
}

export function renderPool(engine, ui) {
  const players = filterPool(engine, ui);
  const visible = players.slice(0, ui.poolLimit);
  const frag = document.createDocumentFragment();

  visible.forEach((player) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'player-row';
    row.dataset.playerId = player.id;
    row.classList.toggle('is-selected', player.id === ui.selectedPlayerId);
    row.classList.toggle('is-drafted', player.draftedBy !== null);
    row.disabled = player.draftedBy !== null;

    const owner = player.draftedBy
      ? engine.teams.find((t) => t.id === player.draftedBy).abbr
      : null;

    row.innerHTML = `
      <span class="badge badge--${player.position.toLowerCase()}">${player.position}</span>
      <span class="player-row__main">
        <span class="player-row__name">${escapeHtml(player.name)}</span>
        <span class="player-row__meta">${player.team} · ${player.position}${player.posRank} · Tier ${player.tier} · ADP ${player.adp}</span>
      </span>
      <span class="player-row__stats">
        <span class="player-row__vor ${player.vor >= 0 ? 'is-pos' : 'is-neg'}">${formatVor(player.vor)}</span>
        <span class="player-row__proj">${player.projection} pts</span>
      </span>
      ${owner ? `<span class="player-row__owner">${owner}</span>` : ''}`;
    frag.appendChild(row);
  });

  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No players match those filters.';
    frag.appendChild(empty);
  }

  dom.playerPool.replaceChildren(frag);
  dom.poolCount.textContent = `${visible.length} of ${players.length}`;

  const selected = ui.selectedPlayerId ? engine.playersById[ui.selectedPlayerId] : null;
  if (selected) {
    dom.selectionName.textContent = selected.name;
    dom.selectionMeta.textContent = `${selected.position}${selected.posRank} · ${selected.team} · VOR ${formatVor(selected.vor)} · ${selected.projection} proj pts`;
  } else {
    dom.selectionName.textContent = 'No player selected';
    dom.selectionMeta.textContent = 'Click a player in the pool to put them on the card.';
  }

  dom.positionFilters.querySelectorAll('[data-position]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.position === ui.position);
  });
}

/* ------------------------------------------------------------------ rosters */

export function renderRosterSelect(engine, ui) {
  const frag = document.createDocumentFragment();
  engine.teams.forEach((team) => {
    const option = document.createElement('option');
    option.value = String(team.id);
    option.textContent = `${team.name}${team.isUser ? ' (You)' : ''}`;
    option.selected = team.id === ui.selectedTeamId;
    frag.appendChild(option);
  });
  dom.rosterTeamSelect.replaceChildren(frag);
}

export function renderRoster(engine, ui) {
  const teamId = ui.selectedTeamId;
  const roster = engine.rosterFor(teamId);
  const frag = document.createDocumentFragment();

  ROSTER_SLOTS.forEach((slot) => {
    const playerId = roster[slot.key];
    const player = playerId ? engine.playersById[playerId] : null;
    const row = document.createElement('div');
    row.className = `roster-slot${player ? '' : ' is-empty'}${slot.starter ? '' : ' is-bench'}`;
    row.innerHTML = `
      <span class="roster-slot__label">${slot.label}</span>
      ${
        player
          ? `<span class="roster-slot__player">
               <span class="badge badge--${player.position.toLowerCase()} badge--sm">${player.position}</span>
               <span class="roster-slot__name">${escapeHtml(player.name)}</span>
               <span class="roster-slot__team">${player.team}</span>
             </span>
             <span class="roster-slot__pts">${player.projection}</span>`
          : `<span class="roster-slot__player roster-slot__player--empty">Empty</span><span class="roster-slot__pts">—</span>`
      }`;
    frag.appendChild(row);
  });
  dom.rosterSlots.replaceChildren(frag);

  // Starter points + positional counts.
  const counts = engine.positionCounts(teamId);
  const starterPoints = ROSTER_SLOTS.filter((s) => s.starter).reduce((sum, slot) => {
    const id = roster[slot.key];
    return sum + (id ? engine.playersById[id].projection : 0);
  }, 0);
  const totalVor = engine.teams
    .find((t) => t.id === teamId)
    .roster.reduce((sum, id) => sum + engine.playersById[id].vor, 0);

  dom.rosterNeeds.innerHTML = `
    <div class="stat"><span class="stat__label">Starter Pts</span><span class="stat__value">${Math.round(starterPoints)}</span></div>
    <div class="stat"><span class="stat__label">Total VOR</span><span class="stat__value">${formatVor(round1(totalVor))}</span></div>
    ${POSITIONS.map(
      (pos) =>
        `<div class="stat stat--pos"><span class="badge badge--${pos.toLowerCase()} badge--sm">${pos}</span><span class="stat__value">${counts[pos]}</span></div>`
    ).join('')}`;
}

/* ---------------------------------------------------- recommendations + feed */

export function renderRecommendations(engine, ui) {
  const teamId = engine.complete ? ui.selectedTeamId : engine.currentTeamId;
  const recs = engine.recommendations(teamId, 5);
  const frag = document.createDocumentFragment();

  recs.forEach(({ player, score }, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'rec-row';
    row.dataset.playerId = player.id;
    row.innerHTML = `
      <span class="rec-row__rank">${index + 1}</span>
      <span class="badge badge--${player.position.toLowerCase()} badge--sm">${player.position}</span>
      <span class="rec-row__name">${escapeHtml(player.name)}</span>
      <span class="rec-row__score">${formatVor(score)}</span>`;
    frag.appendChild(row);
  });

  if (recs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'Roster is full.';
    frag.appendChild(empty);
  }
  dom.recommendations.replaceChildren(frag);

  const scarcity = positionalScarcity(engine.availablePlayers);
  dom.scarcityList.innerHTML = scarcity
    .map(
      (row) => `
      <li class="scarcity">
        <span class="badge badge--${row.position.toLowerCase()} badge--sm">${row.position}</span>
        <span class="scarcity__bar"><span style="width:${Math.min(100, row.depthToReplacement * 4)}%"></span></span>
        <span class="scarcity__count">${row.depthToReplacement} startable</span>
      </li>`
    )
    .join('');
}

export function renderRecentPicks(engine) {
  const recent = [...engine.picks].slice(-14).reverse();
  dom.recentPicks.innerHTML = recent
    .map((pick) => {
      const player = engine.playersById[pick.playerId];
      const team = engine.teams.find((t) => t.id === pick.teamId);
      return `
        <li class="feed-item">
          <span class="feed-item__pick">${pick.round}.${String(pick.slot).padStart(2, '0')}</span>
          <span class="badge badge--${player.position.toLowerCase()} badge--sm">${player.position}</span>
          <span class="feed-item__name">${escapeHtml(player.name)}</span>
          <span class="feed-item__team">${team.abbr}</span>
        </li>`;
    })
    .join('');

  if (recent.length === 0) {
    dom.recentPicks.innerHTML = '<li class="empty-state">No picks yet — start the draft.</li>';
  }
}

/* -------------------------------------------------------------------- misc */

let toastTimer = null;
export function toast(message, tone = 'info') {
  dom.toast.textContent = message;
  dom.toast.className = `toast toast--${tone} is-visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.classList.remove('is-visible');
  }, 2600);
}

/** Full repaint. */
export function renderAll(engine, ui) {
  renderHeader(engine, ui);
  renderBoard(engine, ui);
  renderPool(engine, ui);
  renderRoster(engine, ui);
  renderRecommendations(engine, ui);
  renderRecentPicks(engine);
  refreshIcons();
}

function shortName(name) {
  const parts = name.split(' ');
  if (parts.length === 1) return name;
  if (name.includes('D/ST')) return parts.slice(0, -1).join(' ');
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

function formatVor(value) {
  return `${value > 0 ? '+' : ''}${value}`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}
