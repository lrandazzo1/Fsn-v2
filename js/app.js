/**
 * app.js
 * -----------------------------------------------------------------------------
 * Application shell.
 *
 *  - boots the draft engine and the pick clock
 *  - reads the synced sports data (player pool, weekly projections, NFL slate)
 *    out of Postgres, falling back to the offline pool in playerData.js
 *  - restores state from Supabase (falling back to localStorage, then a fresh
 *    draft) and persists every selection back to Postgres
 *  - registers the navigation flow:
 *      Home Dashboard -> League Overview -> Draft Room / Board -> Team Roster
 *  - owns transient UI state (filters, selections) and every control handler
 */

import { CONFIG } from './config.js';
import { DraftEngine } from './draftEngine.js';
import { createLiveData } from './liveData.js';
import { annotatePlayers, liveSlateWeeks, setLiveSlate } from './nflTeams.js';
import { DraftRepository, SeasonRepository } from './persistence.js';
import { Router } from './router.js';
import { SeasonEngine } from './seasonEngine.js';
import {
  cacheDom,
  dom,
  installImageFallbacks,
  refreshIcons,
  renderAll,
  renderClock,
  renderRosterSelect,
  renderSyncStatus,
  toast
} from './uiRenderer.js';
import { createHomeView } from './views/home.js';
import { createLeagueView } from './views/league.js';
import { createMatchupView } from './views/matchup.js';
import { createTeamView } from './views/team.js';

/** Transient view state — never persisted into the draft itself. */
const ui = {
  search: '',
  position: 'ALL',
  sort: 'vor',
  hideDrafted: true,
  poolLimit: 120,
  selectedTeamId: CONFIG.league.userTeamId,
  selectedPlayerId: null,
  route: 'home',
  /** Season state shared by the Matchup hub, the Team page and the dev bar. */
  week: 1,
  /** The week whose NFL matchups are currently stamped onto the player pool. */
  nflWeek: null,
  matchupMode: 'mine',
  matchupTeamId: CONFIG.league.userTeamId
};

const engine = new DraftEngine({
  teamCount: CONFIG.league.totalTeams,
  rounds: CONFIG.league.rounds,
  userTeamId: CONFIG.league.userTeamId,
  timerSeconds: CONFIG.league.timerSeconds
});

const season = new SeasonEngine({
  engine,
  weeks: CONFIG.season.weeks,
  seed: CONFIG.season.seed
});

const repo = new DraftRepository({ onStatus: (status) => renderSyncStatus(status) });
const seasonRepo = new SeasonRepository(repo);

/** Guards the animated bot loop so two runs never overlap. */
let simulation = { running: false, cancel: false };
let views = {};
let router = null;

/* --------------------------------------------------------------------- boot */

async function init() {
  cacheDom();
  installImageFallbacks();
  renderRosterSelect(engine, ui);
  bindEvents();

  engine.on('change', onEngineChange);
  engine.on('tick', () => renderClock(engine));
  engine.on('expire', onClockExpiry);

  views = {
    home: createHomeView({ engine, config: CONFIG }),
    league: createLeagueView({ engine, season, config: CONFIG }),
    matchups: null, // both need router.go, so they are created below
    team: null
  };

  router = new Router(
    [
      { path: '/', name: 'home', view: { enter: () => views.home.enter() } },
      { path: '/league', name: 'league', view: { enter: () => views.league.enter() } },
      { path: '/draft', name: 'draft', view: { enter: enterDraftRoom, leave: leaveDraftRoom } },
      { path: '/matchups', name: 'matchups', view: { enter: () => views.matchups.enter({}) } },
      { path: '/matchups/:week', name: 'matchups', view: { enter: (params) => views.matchups.enter(params) } },
      { path: '/team/:id', name: 'team', view: { enter: (params) => views.team.enter(params) } }
    ],
    { onChange: onRouteChange }
  );

  views.matchups = createMatchupView({
    engine,
    season,
    ui,
    router,
    onSimulateWeek: simulateWeek,
    onSimulateThrough: simulateThrough,
    onResetSeason: resetSeason
  });
  views.team = createTeamView({ engine, season, ui, router });

  season.on('change', onSeasonChange);
  ui.week = season.currentWeek;

  renderSyncStatus({ status: repo.enabled ? 'idle' : 'offline' });
  router.start();
  renderAll(engine, ui);

  // Before any picks exist: swapping the pool resets the board.
  await loadLiveData();

  await restoreDraft();
  await restoreSeason();
}

/**
 * Moves the app off the static pool and onto the synced sports data.
 *
 * Three things come back from Postgres and each one replaces a placeholder:
 *
 *   fsnv2_players       the draft pool — the same players, but on the roster
 *                       the sync established rather than the one hard-coded in
 *                       playerData.js months ago.
 *   fsnv2_projections   real per-week fantasy points, replacing the
 *                       season-total-over-17 estimate.
 *   fsnv2_nfl_schedule  the real slate behind every "@ MIA" / "vs NYJ" / "BYE"
 *                       tag. There is no generated slate behind it: a week the
 *                       sync has not stored reads '—' rather than inventing a
 *                       fixture (see js/nflTeams.js).
 *
 * The pool and the projections are optional — a disabled, unreachable or empty
 * database leaves the offline pool in place and the app runs as it did before,
 * which is what `npm run dev` with no credentials does.
 */
async function loadLiveData() {
  if (!CONFIG.sportsData.enabled || !repo.enabled) return false;

  const bundle = await repo.liveBundle({
    season: CONFIG.sportsData.season,
    scoringFormat: CONFIG.sportsData.scoringFormat
  });
  if (!bundle) {
    toast('Live data unavailable — using the offline player pool.', 'warn');
    return false;
  }

  const live = createLiveData(bundle);

  if (live.pool.length) engine.usePlayerPool(live.pool);
  if (live.slate.size) setLiveSlate(live.slate);
  if (live.projectionWeeks.length) {
    season.setLiveProjections((player, week) => live.weeklyPoints(player, week));
  }

  if (!live.pool.length && !live.slate.size) {
    toast('No synced data yet — using the offline player pool.', 'info');
    return false;
  }

  // Open on a week the sync actually covers. The league's own week 1 is not
  // the NFL's — a season joined in progress has real data for week 3 and
  // nothing for weeks 1-2 — so landing on week 1 would show '—' against every
  // player even though live numbers were just loaded. Only done while the
  // season is still unplayed; once a week has been simulated, the season's own
  // position wins.
  const covered = [...new Set([...live.projectionWeeks, ...liveSlateWeeks()])]
    .filter((week) => week >= 1 && week <= season.weeks)
    .sort((a, b) => a - b);
  if (covered.length && season.currentWeek === 1 && !season.isWeekPlayed(1)) {
    ui.week = covered[0];
  }

  // Stamp {player.team, player.opponent} for that week, so the lineup and bench
  // components read them straight off the payload.
  setNflWeek(ui.week);

  const weeks = live.projectionWeeks;
  toast(
    `Live data: ${live.pool.length} players, ${live.counts.games} games` +
      (weeks.length ? `, projections for week ${weeks.join(', ')}` : ''),
    'success'
  );
  renderAll(engine, ui);
  return true;
}

/**
 * Stamps every player with the NFL matchup for a week — fantasy week N is NFL
 * week N throughout this app. The week-aware views re-stamp when their own
 * selector moves; this is the boot-time and pool-swap path.
 */
function setNflWeek(week) {
  ui.nflWeek = Number(week) || 1;
  annotatePlayers(engine.playersById, ui.nflWeek);
}

/**
 * Restore order: Supabase draft state -> localStorage snapshot -> fresh room.
 * Whichever wins, the engine replays the picks so the board, rosters and
 * on-the-clock indicator all rebuild from the same source of truth.
 */
async function restoreDraft() {
  const local = repo.loadLocal();

  if (repo.enabled) {
    try {
      const { state, created } = await repo.ensureDraft(CONFIG.league, teamsPayload());
      repo.syncPlayers(Object.values(engine.playersById)).catch(() => {});

      if (state?.picks?.length) {
        engine.hydrate(state.picks);
        toast(`Restored ${state.picks.length} picks from the database.`, 'success');
        return;
      }
      if (created && local?.picks?.length) {
        // New draft row, existing local board — push the local picks up.
        engine.hydrate(local.picks);
        engine.picks.forEach((pick) => repo.recordPick(pick));
        toast(`Synced ${local.picks.length} local picks to the database.`, 'success');
        return;
      }
      renderSyncStatus({ status: 'idle' });
      return;
    } catch (error) {
      renderSyncStatus({ status: 'error', error: error.message });
      toast('Database unreachable — running on local storage.', 'warn');
    }
  }

  if (local?.picks?.length) {
    engine.hydrate(local.picks);
    toast(`Restored ${local.picks.length} picks from this browser.`, 'info');
  }
}

function teamsPayload() {
  return engine.teams.map((team) => ({
    slot: team.id,
    name: team.name,
    abbr: team.abbr,
    is_user: team.isUser
  }));
}

/* ------------------------------------------------------------- engine hooks */

function onEngineChange(payload) {
  if (payload?.reason === 'pick' && payload.pick) {
    repo.recordPick(payload.pick).catch(() => {});
  }
  if (payload?.reason === 'undo') repo.undoPick().catch(() => {});
  if (payload?.reason === 'reset') repo.resetDraft().catch(() => {});

  repo.saveLocal(engine.toJSON());

  if (ui.route === 'draft') renderAll(engine, ui);
  else refreshView();
}

function onClockExpiry({ pick }) {
  if (!pick) return;
  const player = engine.playersById[pick.playerId];
  const team = engine.teamById(pick.teamId);
  toast(`⏱ Clock expired — ${team.abbr} auto-drafted ${player.name} (ADP ${player.adp}).`, 'warn');
  // If the clock ran out on the user, let the bots run back to their next pick.
  if (pick.teamId === engine.userTeamId) runSimulation({ mode: 'toUser' });
}

/* -------------------------------------------------------------- the season */

/**
 * Restore order mirrors the draft: Postgres first, then the localStorage
 * mirror, then the locally generated schedule the engine already built in its
 * constructor. Because the generator is deterministic and mirrored in SQL, all
 * three produce the same 14 weeks — only the scores differ.
 */
async function restoreSeason() {
  if (seasonRepo.enabled && seasonRepo.leagueId) {
    try {
      // Idempotent: creates the schedule the first time, no-ops afterwards.
      await seasonRepo.generateSchedule({ weeks: CONFIG.season.weeks, seed: CONFIG.season.seed });
      const state = await seasonRepo.seasonState();
      if (state?.matchups?.length) {
        season.hydrate({ matchups: state.matchups, scores: state.scores });
        ui.week = season.currentWeek;
        refreshView();
        return;
      }
    } catch (error) {
      toast('Season schedule unavailable — using the local schedule.', 'warn');
    }
  }

  const local = seasonRepo.loadLocal();
  if (local?.matchups?.length) {
    season.hydrate(local);
    ui.week = season.currentWeek;
    refreshView();
  }
}

function onSeasonChange() {
  seasonRepo.saveLocal(season.toJSON());
  refreshView();
}

/**
 * Dev control — the dummy score engine behind the "Simulate Week" button.
 * Scores are rolled locally, then written through fsnv2_simulate_week, which
 * re-sums the team totals from the box score so the database is authoritative.
 */
async function simulateWeek(week) {
  if (season.isWeekPlayed(week)) {
    toast(`Week ${week} has already been played.`, 'warn');
    return;
  }
  if (engine.picks.length === 0) {
    toast('Draft a roster first — there is nothing to score.', 'warn');
    return;
  }

  const { scores } = season.simulateWeek(week);
  toast(`Week ${week} simulated — ${scores.length} player scores.`, 'success');

  try {
    await seasonRepo.simulateWeek(week, scores);
  } catch (error) {
    toast(`Week ${week} saved locally only: ${error.message}`, 'warn');
  }
}

/** Plays every unplayed week up to and including `week`. */
async function simulateThrough(week) {
  const pending = season.weekNumbers.filter((w) => w <= week && !season.isWeekPlayed(w));
  if (pending.length === 0) {
    toast(`Weeks 1-${week} are already final.`, 'info');
    return;
  }
  for (const w of pending) {
    // eslint-disable-next-line no-await-in-loop
    await simulateWeek(w);
  }
  toast(`Simulated ${pending.length} week${pending.length === 1 ? '' : 's'} through week ${week}.`, 'success');
}

/** Rolls the whole season back to unplayed — the schedule itself is kept. */
async function resetSeason() {
  season.resetSeason();
  ui.week = 1;
  toast('Season reset — every week is back to unplayed.', 'info');
  try {
    await seasonRepo.resetSeason();
  } catch {
    /* local mirror already updated by onSeasonChange */
  }
}

/* ---------------------------------------------------------------- routing */

function onRouteChange({ name }) {
  ui.route = name;
  document.querySelectorAll('.view').forEach((section) => {
    section.hidden = section.dataset.view !== name;
  });
  document.querySelectorAll('#navLinks a').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.nav === name);
  });
  window.scrollTo({ top: 0 });
  refreshIcons();
}

function refreshView() {
  // The week on screen can have moved since the last stamp.
  if (ui.nflWeek !== ui.week) setNflWeek(ui.week);
  if (ui.route === 'home') views.home?.render();
  else if (ui.route === 'league') views.league?.render();
  else if (ui.route === 'matchups') views.matchups?.render();
  else if (ui.route === 'team') views.team?.render();
}

function enterDraftRoom() {
  renderAll(engine, ui);
  if (!engine.complete && !engine.clock.running) engine.startClock();
}

function leaveDraftRoom() {
  simulation.cancel = true;
  engine.pauseClock();
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
    if (row) selectPlayer(row.dataset.playerId);
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

  dom.btnClockToggle.addEventListener('click', () => {
    if (engine.complete) return;
    if (engine.clock.running) {
      engine.pauseClock();
      toast('Pick clock paused.', 'info');
    } else if (engine.clock.remaining > 0 && engine.clock.remaining < engine.timerSeconds) {
      engine.resumeClock();
    } else {
      engine.startClock();
    }
    renderClock(engine);
    refreshIcons();
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
    // Resetting the draft empties every roster, so the scores those rosters
    // produced no longer mean anything — the season goes back to unplayed too.
    resetSeason();
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
    if (ui.route !== 'draft') return;
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
    const pick = engine.makePick(ui.selectedPlayerId, { source: 'manual' });
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
      if (!engine.autoPick()) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }
  } finally {
    simulation.running = false;
    setControlsBusy(false);
    if (ui.route === 'draft') renderAll(engine, ui);
  }

  if (engine.complete) toast('Draft complete — review the final board.', 'success');
  else if (engine.isUserOnClock) toast("You're on the clock.", 'success');
}

function announcePick(pick) {
  const player = engine.playersById[pick.playerId];
  const team = engine.teamById(pick.teamId);
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
window.FSN = { engine, season, repo, seasonRepo, ui, get router() { return router; } };
