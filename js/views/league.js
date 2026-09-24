/**
 * views/league.js — League Overview.
 * Settings, the season standings table (W-L, Points For, Points Against) and
 * the route into any franchise's roster.
 *
 * The standings come from the SeasonEngine, so every "Simulate Week" on the
 * Matchup hub moves these records the moment the week goes final. Until a week
 * has been played every row reads 0-0 and the table sorts on projected weekly
 * points instead, which keeps it useful straight out of the draft.
 */

import { ROSTER_SLOTS } from '../types.js';
import { badge, escapeHtml, formatVor, refreshIcons } from '../uiRenderer.js';

export function createLeagueView({ engine, season, config }) {
  const el = {
    name: document.getElementById('leagueName'),
    sub: document.getElementById('leagueSub'),
    tiles: document.getElementById('leagueTiles'),
    chip: document.getElementById('leaguePickChip'),
    table: document.querySelector('#standingsTable tbody'),
    rosterTable: document.querySelector('#rosterTable tbody'),
    rosterChip: document.getElementById('leagueRosterChip'),
    settings: document.getElementById('leagueSettings')
  };

  function render() {
    const draftRows = engine.standings();
    const seasonRows = season.standings();
    const weeksPlayed = season.weekNumbers.filter((week) => season.isWeekPlayed(week)).length;
    const leader = seasonRows[0];

    el.name.textContent = config.league.name;
    el.sub.textContent = `${engine.teamCount} teams · ${config.league.scoringType.toUpperCase()} · ${engine.rounds} rounds · ${season.weeks}-week season`;
    el.chip.textContent = weeksPlayed
      ? `${weeksPlayed} of ${season.weeks} weeks played`
      : engine.complete
        ? 'Draft final · week 1 pending'
        : `Pick ${engine.currentPick} · Round ${engine.currentRound}`;

    el.tiles.innerHTML = [
      tile('users', 'Franchises', `${engine.teamCount}`, 'active managers'),
      tile('calendar-days', 'Weeks Played', `${weeksPlayed}/${season.weeks}`, `${season.matchups.length} games scheduled`),
      tile(
        'crown',
        'Standings Leader',
        leader ? escapeHtml(leader.team.abbr) : '—',
        leader && leader.games
          ? `${leader.wins}-${leader.losses} · ${leader.pointsFor.toFixed(1)} PF`
          : 'no games played yet'
      ),
      tile('layout-grid', 'Board Progress', `${Math.round((engine.picks.length / engine.totalPicks) * 100)}%`, `${engine.picks.length} of ${engine.totalPicks} picks`)
    ].join('');

    // Season standings: W-L-T, PCT, Points For / Against, streak.
    el.table.innerHTML = seasonRows
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
          <td class="record">${row.wins}-${row.losses}${row.ties ? `-${row.ties}` : ''}</td>
          <td class="num">${row.games ? row.pct.toFixed(3).replace(/^0/, '') : '—'}</td>
          <td class="num strong">${row.pointsFor.toFixed(1)}</td>
          <td class="num">${row.pointsAgainst.toFixed(1)}</td>
          <td class="num ${row.diff >= 0 ? 'is-pos' : 'is-neg'}">${row.diff > 0 ? '+' : ''}${row.diff.toFixed(1)}</td>
          <td>${escapeHtml(row.streak)}</td>
          <td class="num">${season.projectedTotal(row.team.id).toFixed(1)}</td>
          <td class="num"><a class="mini-link" href="#/matchups">Games <i data-lucide="chevron-right"></i></a></td>
        </tr>`
      )
      .join('');

    // Roster composition stays on its own table so the standings can breathe.
    el.rosterChip.textContent = `${engine.picks.length} of ${engine.totalPicks} picks`;
    el.rosterTable.innerHTML = draftRows
      .map(
        (row) => `
        <tr class="${row.team.isUser ? 'is-user' : ''}">
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
      ${fact('Season', `${season.weeks} weeks — round robin weeks 1-${engine.teamCount - 1}, randomised rotation after`)}
      ${fact('Roster Size', `${ROSTER_SLOTS.length} players per team`)}
      ${fact('Persistence', 'Supabase / Postgres — leagues, drafts, draft_picks, players, matchups')}`;

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
