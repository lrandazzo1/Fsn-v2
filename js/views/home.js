/**
 * views/home.js — Home Dashboard.
 * Entry point of the flow: Home -> League -> Draft Room -> Team.
 */

import { escapeHtml, pickFeedHtml, refreshIcons } from '../uiRenderer.js';

export function createHomeView({ engine, config }) {
  const el = {
    greeting: document.getElementById('homeGreeting'),
    sub: document.getElementById('homeSub'),
    tiles: document.getElementById('homeTiles'),
    status: document.getElementById('homeStatus'),
    statusChip: document.getElementById('homeStatusChip'),
    feed: document.getElementById('homeFeed')
  };

  function render() {
    const userTeam = engine.teamById(engine.userTeamId);
    const picksAway = engine.picksUntilTurn(engine.userTeamId);
    const nextPick = engine.upcomingPicksForTeam(engine.userTeamId)[0];

    el.greeting.textContent = userTeam.name;
    el.sub.textContent = engine.complete
      ? 'Your draft is complete — review the board and set your lineup.'
      : `Round ${engine.currentRound} of ${engine.rounds} · pick ${engine.currentPick} of ${engine.totalPicks} is on the clock.`;

    el.tiles.innerHTML = [
      tile('layout-grid', 'Picks Made', `${engine.picks.length}`, `of ${engine.totalPicks}`),
      tile(
        'timer',
        'Your Next Pick',
        nextPick ? `#${nextPick}` : '—',
        engine.complete
          ? 'Draft complete'
          : picksAway === 0
            ? 'On the clock now'
            : `${picksAway} pick${picksAway === 1 ? '' : 's'} away`
      ),
      tile('shield', 'Roster Filled', `${userTeam.roster.length}/${engine.rounds}`, 'players rostered'),
      tile('gauge', 'Team VOR', `${engine.teamVor(engine.userTeamId)}`, 'value over replacement')
    ].join('');

    el.statusChip.textContent = engine.complete ? 'complete' : 'in progress';
    el.status.innerHTML = `
      <div class="settings-grid">
        ${fact('League', escapeHtml(config.league.name))}
        ${fact('Format', `${engine.teamCount}-team ${config.league.scoringType.toUpperCase()} snake`)}
        ${fact('Rounds', `${engine.rounds}`)}
        ${fact('Pick Clock', `${engine.timerSeconds}s`)}
        ${fact('On the Clock', engine.complete ? '—' : escapeHtml(engine.currentTeam.name))}
        ${fact('Your Slot', `#${engine.userTeamId}`)}
      </div>
      <div class="cta-row">
        <a class="btn btn--primary" href="#/draft"><i data-lucide="play"></i> ${engine.complete ? 'Review Board' : 'Go to the clock'}</a>
        <a class="btn" href="#/team/${engine.userTeamId}"><i data-lucide="shield"></i> My Roster</a>
      </div>`;

    el.feed.innerHTML = pickFeedHtml(engine, [...engine.picks].slice(-10).reverse());
    refreshIcons();
  }

  return { name: 'home', enter: render, render };
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

function fact(label, value) {
  return `<div class="fact"><span class="fact__label">${label}</span><span class="fact__value">${value}</span></div>`;
}
