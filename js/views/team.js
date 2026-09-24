/**
 * views/team.js — Team Roster / Matchup.
 * End of the navigation flow: a franchise's starters, bench, draft log and a
 * head-to-head projection against any other team in the league.
 */

import { ROSTER_SLOTS } from '../types.js';
import {
  badge,
  escapeHtml,
  formatVor,
  pickFeedHtml,
  refreshIcons,
  renderSlots,
  renderTeamOptions
} from '../uiRenderer.js';

export function createTeamView({ engine, router }) {
  const el = {
    name: document.getElementById('teamName'),
    sub: document.getElementById('teamSub'),
    tiles: document.getElementById('teamTiles'),
    select: document.getElementById('teamSelect'),
    starters: document.getElementById('teamStarters'),
    bench: document.getElementById('teamBench'),
    starterChip: document.getElementById('teamStarterChip'),
    opponent: document.getElementById('opponentSelect'),
    matchup: document.getElementById('matchup'),
    log: document.getElementById('teamPickLog')
  };

  let teamId = engine.userTeamId;
  let opponentId = null;

  el.select.addEventListener('change', (event) => {
    router.go(`/team/${event.target.value}`);
  });

  el.opponent.addEventListener('change', (event) => {
    opponentId = Number(event.target.value);
    render();
  });

  function enter(params = {}) {
    const requested = Number(params.id);
    teamId = Number.isFinite(requested) && engine.teamById(requested) ? requested : engine.userTeamId;
    if (!opponentId || opponentId === teamId) {
      opponentId = teamId === engine.teamCount ? 1 : teamId + 1;
    }
    render();
  }

  function render() {
    const team = engine.teamById(teamId);
    const opponent = engine.teamById(opponentId);
    const standings = engine.standings();
    const rank = standings.find((row) => row.team.id === teamId)?.rank ?? '—';

    renderTeamOptions(el.select, engine, teamId);
    renderTeamOptions(el.opponent, engine, opponentId);

    el.name.innerHTML = `${escapeHtml(team.name)}${team.isUser ? ' <span class="pill pill--you">You</span>' : ''}`;
    el.sub.textContent = `${team.abbr} · draft slot #${team.id} · ${team.roster.length} of ${engine.rounds} picks made`;

    const filled = ROSTER_SLOTS.filter((slot) => slot.starter && engine.rosterFor(teamId)[slot.key]).length;
    const starterCount = ROSTER_SLOTS.filter((slot) => slot.starter).length;

    el.tiles.innerHTML = [
      tile('trophy', 'League Rank', `#${rank}`, 'by starter points'),
      tile('flame', 'Starter Points', `${Math.round(engine.starterPoints(teamId))}`, `${filled}/${starterCount} slots filled`),
      tile('gauge', 'Total VOR', formatVor(engine.teamVor(teamId)), 'value over replacement'),
      tile('users', 'Roster', `${team.roster.length}/${engine.rounds}`, 'players')
    ].join('');

    el.starterChip.textContent = `${filled}/${starterCount} filled`;
    renderSlots(el.starters, engine, teamId, 'starters');
    renderSlots(el.bench, engine, teamId, 'bench');

    renderMatchup(team, opponent);

    const picks = engine.picks.filter((pick) => pick.teamId === teamId);
    el.log.innerHTML = pickFeedHtml(engine, picks);

    refreshIcons();
  }

  function renderMatchup(team, opponent) {
    const home = Math.round(engine.starterPoints(team.id));
    const away = Math.round(engine.starterPoints(opponent.id));
    const total = home + away || 1;
    const margin = home - away;

    el.matchup.innerHTML = `
      <div class="matchup__head">
        <div class="matchup__side ${margin >= 0 ? 'is-leading' : ''}">
          <span class="matchup__abbr">${team.abbr}</span>
          <span class="matchup__name">${escapeHtml(team.name)}</span>
          <span class="matchup__score">${home}</span>
        </div>
        <span class="matchup__vs">vs</span>
        <div class="matchup__side ${margin < 0 ? 'is-leading' : ''}">
          <span class="matchup__abbr">${opponent.abbr}</span>
          <span class="matchup__name">${escapeHtml(opponent.name)}</span>
          <span class="matchup__score">${away}</span>
        </div>
      </div>

      <div class="matchup__bar">
        <span style="width:${(home / total) * 100}%"></span>
      </div>
      <p class="matchup__verdict">
        ${margin === 0
          ? 'Dead even on projections.'
          : `${escapeHtml(margin > 0 ? team.name : opponent.name)} projected by <strong>${Math.abs(margin)}</strong> points.`}
      </p>

      <div class="matchup__slots">
        ${ROSTER_SLOTS.filter((slot) => slot.starter)
          .map((slot) => {
            const mine = playerIn(team.id, slot.key);
            const theirs = playerIn(opponent.id, slot.key);
            const minePts = mine ? mine.projection : 0;
            const theirsPts = theirs ? theirs.projection : 0;
            return `
              <div class="matchup__row">
                <span class="matchup__player ${minePts >= theirsPts ? 'is-win' : ''}">
                  ${mine ? escapeHtml(mine.name) : '<em>empty</em>'}
                  <b>${minePts || '—'}</b>
                </span>
                <span class="matchup__slot">${badge(slot.label === 'FLEX' ? 'FLEX' : slot.label, true)}</span>
                <span class="matchup__player is-right ${theirsPts > minePts ? 'is-win' : ''}">
                  <b>${theirsPts || '—'}</b>
                  ${theirs ? escapeHtml(theirs.name) : '<em>empty</em>'}
                </span>
              </div>`;
          })
          .join('')}
      </div>`;
  }

  function playerIn(id, slotKey) {
    const playerId = engine.rosterFor(id)[slotKey];
    return playerId ? engine.playersById[playerId] : null;
  }

  return { name: 'team', enter, render };
}

function tile(icon, label, value, meta) {
  return `
    <article class="tile">
      <span class="tile__icon"><i data-lucide="${icon}"></i></span>
      <span class="tile__label">${label}</span>
      <span class="tile__value">${value}</span>
      <span class="tile__meta">${meta}</span>
    </article>`;
}
