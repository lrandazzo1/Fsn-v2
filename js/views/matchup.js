/**
 * views/matchup.js — Matchup & Scoreboard hub.
 *
 * Phase 1 showed a single head-to-head projection tucked into the Team page.
 * This is that panel grown into its own screen: a week selector for all 14
 * weeks, a full side-by-side starting-lineup comparison (QB against QB, RB
 * against RB) with player headshots, NFL opponents and projected/actual points, and
 * a League Scoreboard showing all six of the week's games at once.
 *
 * The view owns no state of its own beyond the render — the selected week and
 * mode live in the shared `ui` object so the Team page and the dev toolbar can
 * read the same week.
 */

import { annotatePlayers, hasLiveSlate, playerOpponentLabel } from '../nflTeams.js';
import { badge, escapeHtml, playerAvatar, refreshIcons, renderTeamOptions } from '../uiRenderer.js';

export function createMatchupView({ engine, season, ui, router, onSimulateWeek, onSimulateThrough, onResetSeason }) {
  const el = {
    title: document.getElementById('matchupTitle'),
    sub: document.getElementById('matchupSub'),
    weeks: document.getElementById('matchupWeeks'),
    modes: document.getElementById('matchupModes'),
    teamSelect: document.getElementById('matchupTeamSelect'),
    teamWrap: document.getElementById('matchupTeamWrap'),
    myPanel: document.getElementById('myMatchupPanel'),
    my: document.getElementById('myMatchup'),
    statusChip: document.getElementById('matchupStatusChip'),
    boardPanel: document.getElementById('scoreboardPanel'),
    board: document.getElementById('leagueScoreboard'),
    boardChip: document.getElementById('scoreboardChip'),
    btnSimWeek: document.getElementById('btnSimWeek'),
    btnSimSeason: document.getElementById('btnSimSeason'),
    btnResetSeason: document.getElementById('btnResetSeason')
  };

  /* ------------------------------------------------------------- events -- */

  el.weeks.addEventListener('click', (event) => {
    const button = event.target.closest('[data-week]');
    if (!button) return;
    ui.week = Number(button.dataset.week);
    router.go(`/matchups/${ui.week}`);
  });

  el.modes.addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]');
    if (!button) return;
    ui.matchupMode = button.dataset.mode;
    render();
  });

  el.teamSelect.addEventListener('change', (event) => {
    ui.matchupTeamId = Number(event.target.value);
    render();
  });

  // Clicking a scoreboard card focuses that game in the My Matchup pane.
  el.board.addEventListener('click', (event) => {
    const card = event.target.closest('[data-team-a]');
    if (!card) return;
    ui.matchupTeamId = Number(card.dataset.teamA);
    ui.matchupMode = 'mine';
    render();
  });

  el.btnSimWeek.addEventListener('click', () => onSimulateWeek(ui.week));
  el.btnSimSeason.addEventListener('click', () => onSimulateThrough(ui.week));
  el.btnResetSeason.addEventListener('click', () => onResetSeason());

  /* ------------------------------------------------------------- render -- */

  function enter(params = {}) {
    const requested = Number(params.week);
    if (Number.isFinite(requested) && requested >= 1 && requested <= season.weeks) {
      ui.week = requested;
    } else if (!ui.week) {
      ui.week = season.currentWeek;
    }
    if (!ui.matchupTeamId) ui.matchupTeamId = engine.userTeamId;
    render();
  }

  function render() {
    const week = ui.week || 1;
    const mode = ui.matchupMode || 'mine';
    const played = season.isWeekPlayed(week) && !season.hasLiveScores(week);

    // Re-stamp {player.team, player.opponent} whenever the week on screen
    // moves, so every lineup row below reads the matchup for *this* week.
    if (ui.nflWeek !== week) {
      ui.nflWeek = week;
      annotatePlayers(engine.playersById, week);
    }

    el.title.textContent = `Week ${week}`;
    el.sub.textContent = `${season.weeks}-week season · ${season.matchupsForWeek(week).length} head-to-head games · ${
      played ? 'final' : 'not yet played'
    }`;

    renderWeekBar(week);
    renderTeamOptions(el.teamSelect, engine, ui.matchupTeamId);

    el.modes.querySelectorAll('[data-mode]').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });

    el.myPanel.hidden = mode !== 'mine';
    el.boardPanel.hidden = mode !== 'league';
    el.teamWrap.hidden = mode !== 'mine';

    if (mode === 'mine') renderMyMatchup(week);
    else renderScoreboard(week);

    el.btnSimWeek.disabled = season.isWeekPlayed(week);
    el.btnSimWeek.innerHTML = season.isWeekPlayed(week)
      ? '<i data-lucide="check-circle-2"></i> Week Final'
      : `<i data-lucide="dices"></i> Simulate Week ${week}`;
    el.btnSimSeason.innerHTML = `<i data-lucide="fast-forward"></i> Sim Through ${week}`;

    refreshIcons();
  }

  /** Weeks 1-14, marking which are final and which holds the user's game. */
  function renderWeekBar(current) {
    el.weeks.innerHTML = season.weekNumbers
      .map((week) => {
        const played = season.isWeekPlayed(week) && !season.hasLiveScores(week);
        return `
          <button class="week-chip${week === current ? ' is-active' : ''}${played ? ' is-final' : ''}"
                  data-week="${week}" title="Week ${week}${played ? ' — final' : ''}">
            <span class="week-chip__num">${week}</span>
            <span class="week-chip__state">${played ? 'F' : '·'}</span>
          </button>`;
      })
      .join('');
  }

  /* -------------------------------------------------------- my matchup -- */

  function renderMyMatchup(week) {
    const teamId = ui.matchupTeamId || engine.userTeamId;
    const game = season.matchupForTeam(week, teamId);

    if (!game) {
      el.statusChip.textContent = 'bye';
      el.my.innerHTML = '<p class="empty-state">No game scheduled for this franchise in week ' + week + '.</p>';
      return;
    }

    // Always show the selected franchise on the left, whichever side it is on.
    const flipped = game.teamBId === teamId;
    const home = engine.teamById(flipped ? game.teamBId : game.teamAId);
    const away = engine.teamById(flipped ? game.teamAId : game.teamBId);
    const final = game.status === 'final' && !season.hasLiveScores(week);
    const live = !final && season.hasLiveScores(week);

    const homeScore = season.displayTotal(week, home.id);
    const awayScore = season.displayTotal(week, away.id);
    const homeProj = season.projectedTotal(home.id, week);
    const awayProj = season.projectedTotal(away.id, week);

    // winProbabilityFor() reports the A side; flip it when A is on the right.
    const probA = season.winProbabilityFor(game);
    const homeWinPct = Math.round((flipped ? 1 - probA : probA) * 100);

    el.statusChip.textContent = final ? 'Final' : live ? 'Live scores' : 'Projected';

    el.my.innerHTML = `
      <div class="h2h">
        <div class="h2h__hero">
          <div class="h2h__team ${final && homeScore > awayScore ? 'is-winner' : ''}">
            <span class="h2h__abbr">${escapeHtml(home.abbr)}</span>
            <span class="h2h__team-name">${escapeHtml(home.name)}${home.isUser ? ' <span class="pill pill--you">You</span>' : ''}</span>
            <span class="h2h__record">${escapeHtml(season.recordLabel(home.id))}</span>
          </div>

          <div class="h2h__scores">
            <span class="h2h__score ${final && homeScore > awayScore ? 'is-winner' : ''}">${fmt(homeScore)}</span>
            <span class="h2h__dash">${final ? 'FINAL' : live ? 'ACTUAL' : 'PROJ'}</span>
            <span class="h2h__score ${final && awayScore > homeScore ? 'is-winner' : ''}">${fmt(awayScore)}</span>
          </div>

          <div class="h2h__team is-right ${final && awayScore > homeScore ? 'is-winner' : ''}">
            <span class="h2h__abbr">${escapeHtml(away.abbr)}</span>
            <span class="h2h__team-name">${escapeHtml(away.name)}${away.isUser ? ' <span class="pill pill--you">You</span>' : ''}</span>
            <span class="h2h__record">${escapeHtml(season.recordLabel(away.id))}</span>
          </div>
        </div>

        <!-- Live win probability -->
        <div class="winprob">
          <div class="winprob__head">
            <span class="winprob__pct">${homeWinPct}%</span>
            <span class="winprob__label">${final ? 'Result' : 'Win probability'}</span>
            <span class="winprob__pct is-right">${100 - homeWinPct}%</span>
          </div>
          <div class="winprob__bar"><span style="width:${homeWinPct}%"></span></div>
          <p class="winprob__note">
            Projected total <strong>${fmt(homeProj)}</strong> vs <strong>${fmt(awayProj)}</strong>
            · ${marginNote(home, away, homeProj - awayProj, final, homeScore - awayScore)}
          </p>
        </div>

        <!-- Starting lineups, slot against slot -->
        <div class="h2h__grid">
          <div class="h2h__col-head">
            <span>${escapeHtml(home.abbr)} starters</span>
            <span class="h2h__col-pts">${final || live ? 'PTS / PROJ' : 'PROJ'}</span>
          </div>
          <span class="h2h__col-slot">SLOT</span>
          <div class="h2h__col-head is-right">
            <span class="h2h__col-pts">${final || live ? 'PTS / PROJ' : 'PROJ'}</span>
            <span>${escapeHtml(away.abbr)} starters</span>
          </div>
          ${renderLineupRows(week, home.id, away.id, final)}
          <div class="h2h__total">
            <span class="h2h__total-val">${fmt(homeScore)}</span>
          </div>
          <span class="h2h__col-slot">TOTAL</span>
          <div class="h2h__total is-right">
            <span class="h2h__total-val">${fmt(awayScore)}</span>
          </div>
        </div>
      </div>`;
  }

  /** One row per starter slot, so QB always faces QB. */
  function renderLineupRows(week, homeId, awayId, final) {
    const homeLineup = season.lineup(homeId);
    const awayLineup = season.lineup(awayId);

    return homeLineup
      .map((entry, index) => {
        const theirs = awayLineup[index];
        const mine = pointsFor(week, entry.player, final);
        const yours = pointsFor(week, theirs.player, final);
        const label = entry.slot.label;

        return `
          <div class="h2h__cell">${playerCell(week, entry.player, mine, mine >= yours, false)}</div>
          <span class="h2h__col-slot">${badge(label, true)}</span>
          <div class="h2h__cell is-right">${playerCell(week, theirs.player, yours, yours >= mine, true)}</div>`;
      })
      .join('');
  }

  /**
   * Headshot + name + NFL opponent + points. Mirrored for the away column.
   *
   * The avatar replaces what used to be a bare team badge here: a lineup of
   * eighteen rows all showing BAL/PHI logos told you nothing that the name next
   * to it did not. The team logo survives as the corner overlay on the avatar.
   */
  function playerCell(week, player, points, winning, right) {
    if (!player) {
      return `<span class="h2h__player is-empty">${right ? '' : '<em>Empty</em>'}<b>—</b>${right ? '<em>Empty</em>' : ''}</span>`;
    }

    const status = season.liveStatusFor(week, player);
    const meta = `
      <span class="h2h__player-main">
        <span class="h2h__player-name">${escapeHtml(player.name)}${status === 'in_progress' ? ' <em class="live-badge">LIVE</em>' : ''}</span>
        <span class="h2h__player-meta${
          hasLiveSlate(week) && !player.onBye ? '' : ' is-projected'
        }">${player.position} · ${escapeHtml(player.team)} · ${escapeHtml(
          playerOpponentLabel(player, week)
        )}</span>
      </span>`;
    const actual = season.hasLiveScores(week) ? season.livePointFor(week, player)
      : season.isWeekPlayed(week) ? season.scoreFor(week, player.id) : null;
    const projection = season.weeklyProjection(player, week);
    const pts = `<span class="h2h__points"><b class="${winning ? 'is-win' : ''}">${fmt(points)}</b>${actual !== null || season.hasLiveScores(week) ? `<small>Proj ${fmt(projection)}</small>` : ''}</span>`;
    const face = playerAvatar(player, { size: 'md' });

    return `<span class="h2h__player${winning ? ' is-win' : ''}">${
      right ? `${pts}${meta}${face}` : `${face}${meta}${pts}`
    }</span>`;
  }

  /** Actual points once the week is final, the weekly projection until then. */
  function pointsFor(week, player, final) {
    if (!player) return 0;
    if (!final) return season.livePointFor(week, player) ?? (season.hasLiveScores(week) ? 0 : season.weeklyProjection(player, week));
    const scored = season.scoreFor(week, player.id);
    return scored === null ? season.weeklyProjection(player, week) : scored;
  }

  /* -------------------------------------------------------- scoreboard -- */

  function renderScoreboard(week) {
    const games = season.matchupsForWeek(week);
    const played = season.isWeekPlayed(week);
    el.boardChip.textContent = `${games.length} games · ${played ? 'final' : season.hasLiveScores(week) ? 'live scores' : 'projected'}`;

    el.board.innerHTML = games
      .map((game) => {
        const a = engine.teamById(game.teamAId);
        const b = engine.teamById(game.teamBId);
        const final = game.status === 'final' && !season.hasLiveScores(week);
        const scoreA = season.displayTotal(week, a.id);
        const scoreB = season.displayTotal(week, b.id);
        const pctA = Math.round(season.winProbabilityFor(game) * 100);

        return `
          <article class="game-card${a.isUser || b.isUser ? ' is-user' : ''}"
                   data-team-a="${a.id}" title="Open ${escapeHtml(a.name)} vs ${escapeHtml(b.name)}">
            <header class="game-card__head">
              <span class="game-card__status ${final ? 'is-final' : season.hasLiveScores(week) ? 'is-live' : ''}">${final ? 'FINAL' : season.hasLiveScores(week) ? 'ACTUAL' : 'PROJ'}</span>
              <span class="game-card__week">Week ${week}</span>
            </header>

            ${scoreboardSide(a, scoreA, final && scoreA > scoreB, season.recordLabel(a.id), week, final)}
            ${scoreboardSide(b, scoreB, final && scoreB > scoreA, season.recordLabel(b.id), week, final)}

            <div class="game-card__bar" title="${pctA}% ${escapeHtml(a.abbr)}">
              <span style="width:${pctA}%"></span>
            </div>
          </article>`;
      })
      .join('');
  }

  function scoreboardSide(team, score, winner, record, week, final) {
    return `
      <div class="game-card__side${winner ? ' is-winner' : ''}">
        <span class="game-card__abbr">${escapeHtml(team.abbr)}</span>
        <span class="game-card__name">
          ${escapeHtml(team.name)}${team.isUser ? ' <em>(You)</em>' : ''}
          <span class="game-card__record">${escapeHtml(record)}</span>
        </span>
        <span class="game-card__score">${fmt(score)}${!final && season.hasLiveScores(week)
          ? `<small>Proj ${fmt(season.projectedTotal(team.id, week))}</small>` : ''}</span>
      </div>`;
  }

  return { name: 'matchups', enter, render };
}

/* ----------------------------------------------------------------- helpers */

function fmt(value) {
  return Number(value || 0).toFixed(1);
}

function marginNote(home, away, projMargin, final, actualMargin) {
  const margin = final ? actualMargin : projMargin;
  if (Math.abs(margin) < 0.05) return 'dead even';
  const leader = margin > 0 ? home : away;
  return `${escapeHtml(leader.name)} ${final ? 'won' : 'favoured'} by <strong>${Math.abs(margin).toFixed(1)}</strong>`;
}
