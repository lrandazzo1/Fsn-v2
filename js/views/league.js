/**
 * views/league.js — League Overview.
 * Settings, live standings by projected starter points, and the route into any
 * franchise's roster.
 */

import { ROSTER_SLOTS } from '../types.js';
import { badge, escapeHtml, formatVor, refreshIcons } from '../uiRenderer.js';

export function createLeagueView({ engine, config }) {
  const el = {
    name: document.getElementById('leagueName'),
    sub: document.getElementById('leagueSub'),
    tiles: document.getElementById('leagueTiles'),
    chip: document.getElementById('leaguePickChip'),
    table: document.querySelector('#standingsTable tbody'),
    settings: document.getElementById('leagueSettings')
  };

  function render() {
    const standings = engine.standings();
    const best = standings[0];

    el.name.textContent = config.league.name;
    el.sub.textContent = `${engine.teamCount} teams · ${config.league.scoringType.toUpperCase()} · ${engine.rounds} rounds · ${engine.timerSeconds}s clock`;
    el.chip.textContent = engine.complete
      ? 'Final'
      : `Pick ${engine.currentPick} · Round ${engine.currentRound}`;

    el.tiles.innerHTML = [
      tile('users', 'Franchises', `${engine.teamCount}`, 'active managers'),
      tile('layout-grid', 'Board Progress', `${Math.round((engine.picks.length / engine.totalPicks) * 100)}%`, `${engine.picks.length} of ${engine.totalPicks} picks`),
      tile('crown', 'Top Roster', best ? escapeHtml(best.team.abbr) : '—', best ? `${best.starterPoints} starter pts` : 'no picks yet'),
      tile('database', 'Players Pooled', `${Object.keys(engine.playersById).length}`, 'projection rows')
    ].join('');

    el.table.innerHTML = standings
      .map(
        (row) => `
        <tr class="${row.team.isUser ? 'is-user' : ''}">
          <td class="rank">${row.rank}</td>
          <td>
            <a class="team-link" href="#/team/${row.team.id}">
              <span class="team-link__abbr">${row.team.abbr}</span>
              <span>${escapeHtml(row.team.name)}${row.team.isUser ? ' <em>(You)</em>' : ''}</span>
            </a>
          </td>
          <td>${row.picks}</td>
          <td>${row.counts.QB}</td>
          <td>${row.counts.RB}</td>
          <td>${row.counts.WR}</td>
          <td>${row.counts.TE}</td>
          <td>${row.counts.K}</td>
          <td>${row.counts.DST}</td>
          <td class="num">${formatVor(row.vor)}</td>
          <td class="num strong">${row.starterPoints}</td>
          <td class="num"><a class="mini-link" href="#/team/${row.team.id}">Roster <i data-lucide="chevron-right"></i></a></td>
        </tr>`
      )
      .join('');

    const starters = ROSTER_SLOTS.filter((slot) => slot.starter);
    el.settings.innerHTML = `
      ${fact('Draft Type', 'Snake — odd rounds 1→N, even rounds N→1')}
      ${fact('Scoring', config.league.scoringType.toUpperCase())}
      ${fact('Rounds', `${engine.rounds}`)}
      ${fact('Pick Clock', `${engine.timerSeconds} seconds, auto-pick on expiry (best ADP)`)}
      ${fact('Starters', starters.map((slot) => badge(slot.label === 'FLEX' ? 'FLEX' : slot.label, true)).join(' '))}
      ${fact('Bench', `${ROSTER_SLOTS.length - starters.length} slots`)}
      ${fact('Persistence', 'Supabase / Postgres — leagues, drafts, draft_picks, players')}
      ${fact('Roster Size', `${ROSTER_SLOTS.length} players per team`)}`;

    refreshIcons();
  }

  return { name: 'league', enter: render, render };
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
