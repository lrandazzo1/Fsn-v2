/**
 * views/team.js — Team Roster.
 * A franchise's starters, bench, draft log and its game for the selected week.
 *
 * The full side-by-side comparison now lives on the Matchup & Scoreboard hub
 * (js/views/matchup.js); what is left here is the summary card that links to
 * it, driven by the same `ui.week` so the two screens never disagree about
 * which week is being looked at.
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

export function createTeamView({ engine, season, ui, router }) {
  const el = {
    name: document.getElementById('teamName'),
    sub: document.getElementById('teamSub'),
    tiles: document.getElementById('teamTiles'),
    select: document.getElementById('teamSelect'),
    starters: document.getElementById('teamStarters'),
    bench: document.getElementById('teamBench'),
    starterChip: document.getElementById('teamStarterChip'),
    week: document.getElementById('teamWeekSelect'),
    matchupHead: document.getElementById('teamMatchupHead'),
    matchup: document.getElementById('matchup'),
    log: document.getElementById('teamPickLog')
  };

  let teamId = engine.userTeamId;

  el.select.addEventListener('change', (event) => {
    router.go(`/team/${event.target.value}`);
  });

  el.week.addEventListener('change', (event) => {
    ui.week = Number(event.target.value);
    render();
  });

  function enter(params = {}) {
    const requested = Number(params.id);
    teamId = Number.isFinite(requested) && engine.teamById(requested) ? requested : engine.userTeamId;
    render();
  }

  function render() {
    const team = engine.teamById(teamId);
    const week = ui.week || 1;
    const record = season.recordFor(teamId);
    const rank = record?.rank ?? '—';

    renderTeamOptions(el.select, engine, teamId);
    renderWeekOptions(el.week, season, week);

    el.name.innerHTML = `${escapeHtml(team.name)}${team.isUser ? ' <span class="pill pill--you">You</span>' : ''}`;
    el.sub.textContent = `${team.abbr} · draft slot #${team.id} · ${team.roster.length} of ${engine.rounds} picks made`;

    const filled = ROSTER_SLOTS.filter((slot) => slot.starter && engine.rosterFor(teamId)[slot.key]).length;
    const starterCount = ROSTER_SLOTS.filter((slot) => slot.starter).length;

    el.tiles.innerHTML = [
      tile('trophy', 'Record', season.recordLabel(teamId), `#${rank} in the league`),
      tile('flame', 'Points For', record ? record.pointsFor.toFixed(1) : '0.0', `${record?.games ?? 0} games played`),
      tile('shield-half', 'Points Against', record ? record.pointsAgainst.toFixed(1) : '0.0', `streak ${record?.streak ?? '—'}`),
      tile('gauge', 'Total VOR', formatVor(engine.teamVor(teamId)), `${team.roster.length}/${engine.rounds} rostered · ${filled}/${starterCount} starters`)
    ].join('');

    el.starterChip.textContent = `${filled}/${starterCount} filled`;
    renderSlots(el.starters, engine, teamId, 'starters', week);
    renderSlots(el.bench, engine, teamId, 'bench', week);

    renderMatchup(team, week);

    const picks = engine.picks.filter((pick) => pick.teamId === teamId);
    el.log.innerHTML = pickFeedHtml(engine, picks);

    refreshIcons();
  }

  /**
   * The week summary: who this franchise plays, the projected or final score,
   * and a route into the full side-by-side comparison on the hub. The deep
   * per-slot breakdown deliberately lives there, not here.
   */
  function renderMatchup(team, week) {
    const game = season.matchupForTeam(week, team.id);

    el.matchupHead.textContent = `Week ${week} Matchup`;

    if (!game) {
      el.matchup.innerHTML = `<p class="empty-state">No game scheduled in week ${week}.</p>`;
      return;
    }

    const opponentId = season.opponentOf(week, team.id);
    const opponent = engine.teamById(opponentId);
    const final = game.status === 'final';

    const mine = season.displayTotal(week, team.id);
    const theirs = season.displayTotal(week, opponentId);
    const total = mine + theirs || 1;
    const margin = mine - theirs;

    // winProbabilityFor() reports the A side; flip it when this team is B.
    const probA = season.winProbabilityFor(game);
    const winPct = Math.round((game.teamAId === team.id ? probA : 1 - probA) * 100);

    el.matchup.innerHTML = `
      <div class="matchup__head">
        <div class="matchup__side ${margin >= 0 ? 'is-leading' : ''}">
          <span class="matchup__abbr">${team.abbr} · ${escapeHtml(season.recordLabel(team.id))}</span>
          <span class="matchup__name">${escapeHtml(team.name)}</span>
          <span class="matchup__score">${mine.toFixed(1)}</span>
        </div>
        <span class="matchup__vs">${final ? 'final' : 'vs'}</span>
        <div class="matchup__side ${margin < 0 ? 'is-leading' : ''}">
          <span class="matchup__abbr">${opponent.abbr} · ${escapeHtml(season.recordLabel(opponentId))}</span>
          <span class="matchup__name">${escapeHtml(opponent.name)}</span>
          <span class="matchup__score">${theirs.toFixed(1)}</span>
        </div>
      </div>

      <div class="matchup__bar">
        <span style="width:${(mine / total) * 100}%"></span>
      </div>
      <p class="matchup__verdict">
        ${final
          ? `${escapeHtml(margin >= 0 ? team.name : opponent.name)} won by <strong>${Math.abs(margin).toFixed(1)}</strong>.`
          : `<strong>${winPct}%</strong> win probability · projected by <strong>${Math.abs(margin).toFixed(1)}</strong>.`}
      </p>

      <div class="matchup__slots">
        ${ROSTER_SLOTS.filter((slot) => slot.starter)
          .map((slot) => {
            const me = playerIn(team.id, slot.key);
            const them = playerIn(opponentId, slot.key);
            const minePts = slotPoints(week, me, final);
            const themPts = slotPoints(week, them, final);
            return `
              <div class="matchup__row">
                <span class="matchup__player ${minePts >= themPts ? 'is-win' : ''}">
                  ${me ? escapeHtml(me.name) : '<em>empty</em>'}
                  <b>${me ? minePts.toFixed(1) : '—'}</b>
                </span>
                <span class="matchup__slot">${badge(slot.label === 'FLEX' ? 'FLEX' : slot.label, true)}</span>
                <span class="matchup__player is-right ${themPts > minePts ? 'is-win' : ''}">
                  <b>${them ? themPts.toFixed(1) : '—'}</b>
                  ${them ? escapeHtml(them.name) : '<em>empty</em>'}
                </span>
              </div>`;
          })
          .join('')}
      </div>

      <div class="cta-row">
        <a class="btn btn--primary" href="#/matchups/${week}">
          <i data-lucide="swords"></i> Full Scoreboard
        </a>
      </div>`;
  }

  /** Actual points once the week is final, the weekly projection until then. */
  function slotPoints(week, player, final) {
    if (!player) return 0;
    if (!final) return season.weeklyProjection(player, week);
    const scored = season.scoreFor(week, player.id);
    return scored === null ? season.weeklyProjection(player, week) : scored;
  }

  function playerIn(id, slotKey) {
    const playerId = engine.rosterFor(id)[slotKey];
    return playerId ? engine.playersById[playerId] : null;
  }

  return { name: 'team', enter, render };
}

/** Weeks 1-14 in the Team page's own selector, kept in step with ui.week. */
function renderWeekOptions(select, season, selected) {
  const frag = document.createDocumentFragment();
  season.weekNumbers.forEach((week) => {
    const option = document.createElement('option');
    option.value = String(week);
    option.textContent = `Week ${week}${season.isWeekPlayed(week) ? ' · final' : ''}`;
    option.selected = week === Number(selected);
    frag.appendChild(option);
  });
  select.replaceChildren(frag);
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
