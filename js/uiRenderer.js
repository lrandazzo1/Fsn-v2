/**
 * uiRenderer.js
 * -----------------------------------------------------------------------------
 * Rendering layer for the draft room. Every function takes the engine plus the
 * UI state object and rewrites a single region, so the view is always a pure
 * function of state and can never drift out of sync with the draft.
 *
 * Shared helpers (badges, roster slot rows, escaping) are exported for the
 * Dashboard / League / Team views in js/views/.
 */

import { POSITIONS, ROSTER_SLOTS } from './types.js';
import { positionalScarcity } from './vorMath.js';

/** Cached element lookups. */
export const dom = {};

/** Grab every element the draft room touches, once. */
export function cacheDom() {
  const ids = [
    'onClockTeam', 'onClockMeta', 'clockEyebrow', 'roundLabel', 'pickLabel', 'progressBar',
    'progressText', 'draftBoard', 'playerPool', 'poolCount', 'playerSearch', 'positionFilters',
    'sortSelect', 'rosterTeamSelect', 'rosterSlots', 'rosterNeeds', 'recommendations',
    'recentPicks', 'selectionName', 'selectionMeta', 'btnMakePick', 'btnAutoPick', 'btnSimRound',
    'btnSimToMe', 'btnUndo', 'btnReset', 'toggleAutoDraft', 'toast', 'scarcityList',
    'hideDraftedWrap', 'boardStatus', 'clockTime', 'clockRing', 'pickClock', 'btnClockToggle',
    'nextUpList', 'syncPill', 'syncLabel'
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
  const team = engine.currentTeam;
  const userTeam = engine.teamById(engine.userTeamId);
  const picksAway = engine.picksUntilTurn(engine.userTeamId);

  dom.onClockTeam.textContent = engine.complete ? 'Draft Complete' : team.name;
  dom.onClockTeam.classList.toggle('is-user', !engine.complete && team.isUser);
  dom.clockEyebrow.hidden = engine.complete;

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

  renderClock(engine);
  renderNextUp(engine);
}

/** Pick clock: countdown ring + remaining seconds. */
export function renderClock(engine) {
  const timer = engine.clock;
  const circumference = 2 * Math.PI * 19;
  dom.clockTime.textContent = engine.complete ? '—' : timer.display;
  dom.clockRing.style.strokeDasharray = `${circumference}`;
  dom.clockRing.style.strokeDashoffset = `${circumference * (1 - timer.fraction)}`;

  const urgent = timer.running && timer.remaining <= 10;
  dom.pickClock.classList.toggle('is-urgent', urgent);
  dom.pickClock.classList.toggle('is-running', timer.running);
  dom.btnClockToggle.innerHTML = `<i data-lucide="${timer.running ? 'pause' : 'play'}"></i>`;
  dom.btnClockToggle.disabled = engine.complete;
}

/** "Next up" strip — recomputed from snake order on every pick. */
export function renderNextUp(engine) {
  const preview = engine.nextUp(4);
  dom.nextUpList.innerHTML = preview.length
    ? preview
        .map(
          (row) => `
      <li class="next-up__item${row.isUser ? ' is-user' : ''}">
        <span class="next-up__pick">${row.round}.${String(row.slot).padStart(2, '0')}</span>
        <span class="next-up__team">${escapeHtml(row.team.abbr)}</span>
      </li>`
        )
        .join('')
    : '<li class="next-up__item is-empty">Board complete</li>';
}

/** Database sync indicator in the nav bar. */
export function renderSyncStatus({ status, pending = 0, error = null }) {
  if (!dom.syncPill) return;
  const labels = {
    idle: 'db ready',
    syncing: pending ? `syncing ${pending}` : 'syncing',
    synced: 'db synced',
    offline: 'local only',
    error: 'sync error'
  };
  dom.syncLabel.textContent = labels[status] || status;
  dom.syncPill.className = `sync-pill is-${status}`;
  dom.syncPill.title = error || `Supabase persistence: ${labels[status] || status}`;
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
    label.classList.add(round % 2 === 0 ? 'is-reverse' : 'is-forward');
    label.title = round % 2 === 0 ? `Round ${round}: teams ${teamCount} → 1` : `Round ${round}: teams 1 → ${teamCount}`;
    frag.appendChild(label);

    // One cell per TEAM column: the snake decides which pick number lands
    // there, so round 2 shows pick 13 under team 12 and pick 24 under team 1.
    for (let teamId = 1; teamId <= teamCount; teamId += 1) {
      const overall = engine.pickNumberFor(round, teamId);
      const pick = engine.pickForTeam(round, teamId);
      const cell = boardCell('board-cell', '');
      cell.dataset.teamId = String(teamId);
      cell.dataset.overall = String(overall);
      cell.classList.toggle('is-selected-team', teamId === ui.selectedTeamId);
      cell.classList.toggle('is-user-team', teamId === engine.userTeamId);

      if (pick) {
        const player = engine.playersById[pick.playerId];
        cell.classList.add('is-filled', `pos-${player.position.toLowerCase()}`);
        cell.innerHTML = `
          <span class="board-cell__meta">${overall}.${pick.source === 'timer_expiry' ? ' ⏱' : pick.auto ? ' AUTO' : ''}</span>
          <span class="board-cell__name">${escapeHtml(shortName(player.name))}</span>
          <span class="board-cell__pos">${player.position} · ${player.team}</span>`;
      } else if (overall === engine.currentPick && !engine.complete) {
        cell.classList.add('is-onclock');
        cell.innerHTML = `
          <span class="board-cell__meta">${overall}</span>
          <span class="board-cell__name">ON THE CLOCK</span>
          <span class="board-cell__pos">${engine.teamById(teamId).abbr}</span>`;
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

    const owner = player.draftedBy ? engine.teamById(player.draftedBy).abbr : null;

    row.innerHTML = `
      ${badge(player.position)}
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

export function renderTeamOptions(select, engine, selectedId) {
  const frag = document.createDocumentFragment();
  engine.teams.forEach((team) => {
    const option = document.createElement('option');
    option.value = String(team.id);
    option.textContent = `${team.name}${team.isUser ? ' (You)' : ''}`;
    option.selected = team.id === Number(selectedId);
    frag.appendChild(option);
  });
  select.replaceChildren(frag);
}

export function renderRosterSelect(engine, ui) {
  renderTeamOptions(dom.rosterTeamSelect, engine, ui.selectedTeamId);
}

/**
 * Renders roster slot rows into any container.
 * @param {HTMLElement} container
 * @param {'all'|'starters'|'bench'} scope
 */
export function renderSlots(container, engine, teamId, scope = 'all') {
  const roster = engine.rosterFor(teamId);
  const slots = ROSTER_SLOTS.filter((slot) =>
    scope === 'all' ? true : scope === 'starters' ? slot.starter : !slot.starter
  );
  const frag = document.createDocumentFragment();

  slots.forEach((slot) => {
    const playerId = roster[slot.key];
    const player = playerId ? engine.playersById[playerId] : null;
    const row = document.createElement('div');
    row.className = `roster-slot${player ? '' : ' is-empty'}${slot.starter ? '' : ' is-bench'}`;
    row.innerHTML = `
      <span class="roster-slot__label">${slot.label}</span>
      ${
        player
          ? `<span class="roster-slot__player">
               ${badge(player.position, true)}
               <span class="roster-slot__name">${escapeHtml(player.name)}</span>
               <span class="roster-slot__team">${player.team}${
                 player.opponent && player.opponent !== '—' ? ` · ${player.opponent}` : ''
               }</span>
             </span>
             <span class="roster-slot__pts">${player.projection}</span>`
          : '<span class="roster-slot__player roster-slot__player--empty">Empty</span><span class="roster-slot__pts">—</span>'
      }`;
    frag.appendChild(row);
  });
  container.replaceChildren(frag);
}

export function renderRoster(engine, ui) {
  const teamId = ui.selectedTeamId;
  renderSlots(dom.rosterSlots, engine, teamId, 'all');

  const counts = engine.positionCounts(teamId);
  dom.rosterNeeds.innerHTML = `
    <div class="stat"><span class="stat__label">Starter Pts</span><span class="stat__value">${Math.round(engine.starterPoints(teamId))}</span></div>
    <div class="stat"><span class="stat__label">Total VOR</span><span class="stat__value">${formatVor(engine.teamVor(teamId))}</span></div>
    ${POSITIONS.map(
      (pos) => `<div class="stat stat--pos">${badge(pos, true)}<span class="stat__value">${counts[pos]}</span></div>`
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
      ${badge(player.position, true)}
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

  dom.scarcityList.innerHTML = positionalScarcity(engine.availablePlayers)
    .map(
      (row) => `
      <li class="scarcity">
        ${badge(row.position, true)}
        <span class="scarcity__bar"><span style="width:${Math.min(100, row.depthToReplacement * 4)}%"></span></span>
        <span class="scarcity__count">${row.depthToReplacement} startable</span>
      </li>`
    )
    .join('');
}

/** Pick feed — reused by the draft room and the dashboard. */
export function pickFeedHtml(engine, picks) {
  if (picks.length === 0) return '<li class="empty-state">No picks yet — start the draft.</li>';
  return picks
    .map((pick) => {
      const player = engine.playersById[pick.playerId];
      const team = engine.teamById(pick.teamId);
      return `
        <li class="feed-item">
          <span class="feed-item__pick">${pick.round}.${String(pick.slot).padStart(2, '0')}</span>
          ${badge(player.position, true)}
          <span class="feed-item__name">${escapeHtml(player.name)}</span>
          <span class="feed-item__team">${team.abbr}${pick.source === 'timer_expiry' ? ' ⏱' : ''}</span>
        </li>`;
    })
    .join('');
}

export function renderRecentPicks(engine) {
  dom.recentPicks.innerHTML = pickFeedHtml(engine, [...engine.picks].slice(-14).reverse());
}

/* -------------------------------------------------------------------- misc */

let toastTimer = null;
export function toast(message, tone = 'info') {
  dom.toast.textContent = message;
  dom.toast.className = `toast toast--${tone} is-visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('is-visible'), 2600);
}

/** Full repaint of the draft room. */
export function renderAll(engine, ui) {
  renderHeader(engine, ui);
  renderBoard(engine, ui);
  renderPool(engine, ui);
  renderRoster(engine, ui);
  renderRecommendations(engine, ui);
  renderRecentPicks(engine);
  refreshIcons();
}

/* ------------------------------------------------------------- helpers ---- */

export function badge(position, small = false) {
  return `<span class="badge badge--${position.toLowerCase()}${small ? ' badge--sm' : ''}">${position}</span>`;
}

export function shortName(name) {
  const parts = name.split(' ');
  if (parts.length === 1) return name;
  if (name.includes('D/ST')) return parts.slice(0, -1).join(' ');
  return `${parts[0][0]}. ${parts.slice(1).join(' ')}`;
}

export function formatVor(value) {
  return `${value > 0 ? '+' : ''}${value}`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}
