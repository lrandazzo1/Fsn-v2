/**
 * providers/tank01.ts
 * -----------------------------------------------------------------------------
 * The default fetcher: Tank01 NFL Live In-Game Real Time Statistics on
 * RapidAPI, and by extension any RapidAPI host that speaks the same
 * `{ statusCode, body }` envelope.
 *
 *   SPORTS_DATA_API_KEY   -> x-rapidapi-key
 *   SPORTS_DATA_API_HOST  -> x-rapidapi-host, and the default base URL
 *
 * Endpoint paths come from env (SPORTS_DATA_ENDPOINT_TEAMS, …_PROJECTIONS,
 * …_GAMES, …_BOX_SCORE, …_PLAYER_LIST, …_ROSTER), so a vendor that keeps the
 * same payload shape under different paths needs no code change at all.
 *
 * Everything vendor-specific in the ingestion layer lives in this file: the
 * envelope, the endpoint names, the scoring query parameters and the field
 * names. The rows it returns are ours (lib/services/types.ts).
 */

import type { Logger } from '../logger.ts';
import { silentLogger } from '../logger.ts';
import type { HttpClient } from '../httpClient.ts';
import { createHttpClient } from '../httpClient.ts';
import type { SportsDataEnv } from '../env.ts';
import {
  assertWeek,
  fantasyPosition,
  flattenStats,
  gameStatus,
  kickoffIso,
  num,
  optionalNum,
  teamAbbr,
  text
} from '../normalize.ts';
import type {
  GameRow,
  PlayerRow,
  ProjectionRow,
  ProviderContext,
  ProviderDescription,
  ScoringFormat,
  SportsDataProvider,
  StatLine,
  TeamRow,
  WeeklyStatRow
} from '../types.ts';

export const TANK01_PROVIDER_NAME = 'tank01';

/**
 * Scoring query parameters. Tank01 computes fantasy points server-side from
 * these, so the projections and box scores we store already match the league's
 * scoring rules instead of needing a second pass.
 */
const SCORING_PARAMS: Record<ScoringFormat, Record<string, string | number>> = {
  standard: { pointsPerReception: 0 },
  half_ppr: { pointsPerReception: 0.5 },
  ppr: { pointsPerReception: 1 },
  superflex: { pointsPerReception: 1 },
  custom: {}
};

const BASE_SCORING: Record<string, string | number> = {
  passYards: 0.04,
  passTD: 4,
  passInterceptions: -2,
  passCompletions: 0,
  passAttempts: 0,
  carries: 0,
  rushYards: 0.1,
  rushTD: 6,
  fumbles: -2,
  receivingYards: 0.1,
  receivingTD: 6,
  targets: 0,
  twoPointConversions: 2,
  fgMade: 3,
  fgMissed: -1,
  xpMade: 1,
  xpMissed: -1,
  idwTackleSolo: 0,
  defTD: 6,
  defSack: 1,
  defInt: 2,
  defFumblesRecovered: 2,
  defSafety: 2
};

function scoringQuery(format: ScoringFormat): Record<string, string | number> {
  return { ...BASE_SCORING, ...SCORING_PARAMS[format] };
}

/**
 * Identity fields that look numeric but are not statistics. Without this,
 * `stats` picks up `playerID: 4430807` and `teamID: 6`.
 */
const STAT_EXCLUDE = new Set([
  '__key',
  'playerID',
  'teamID',
  'teamAbv',
  'team',
  'pos',
  'position',
  'longName',
  'espnName',
  'cbsShortName',
  'opponent',
  'gameID',
  'gameWeek',
  'season',
  'week',
  'jerseyNum',
  'fantasyPoints',
  'fantasyPointsDefault',
  'snapCounts'
]);

const statsOf = (entry: Record<string, unknown>): StatLine =>
  flattenStats(entry, '', { exclude: STAT_EXCLUDE });

/**
 * Fantasy points, however this host reports them: a flat value computed from our
 * scoring query parameters, or Tank01's `fantasyPointsDefault` — which is a
 * string on defense rows and a `{ standard, halfPPR, PPR }` object on player
 * rows, so the league's format picks the branch.
 */
function fantasyPointsOf(entry: Record<string, unknown>, format: ScoringFormat): number {
  const direct = optionalNum(entry.fantasyPoints);
  if (direct !== null) return direct;

  const fallback = entry.fantasyPointsDefault;
  if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
    const table = fallback as Record<string, unknown>;
    const key = format === 'standard' ? 'standard' : format === 'half_ppr' ? 'halfPPR' : 'PPR';
    return num(table[key] ?? table.PPR ?? Object.values(table)[0]);
  }
  return num(fallback);
}

/**
 * Team-defense scoring, matching the defensive weights this provider is already
 * asked to use for skill players (see BASE_SCORING) plus the conventional
 * points-allowed tiers. Needed because a box score's `DST` node carries only raw
 * defensive stats — no fantasy total — so a team defense would otherwise score
 * zero every week. Projections, which do carry a total, keep the provider's.
 */
const DST_WEIGHTS = {
  sack: 1,
  interception: 2,
  fumbleRecovery: 2,
  touchdown: 6,
  safety: 2,
  blockedKick: 2
};

export function pointsAllowedBonus(pointsAllowed: number): number {
  if (pointsAllowed <= 0) return 10;
  if (pointsAllowed <= 6) return 7;
  if (pointsAllowed <= 13) return 4;
  if (pointsAllowed <= 20) return 1;
  if (pointsAllowed <= 27) return 0;
  if (pointsAllowed <= 34) return -1;
  return -4;
}

/** The stat names differ between the projections and box-score payloads. */
function firstNum(entry: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = optionalNum(entry[key]);
    if (value !== null) return value;
  }
  return 0;
}

/** Returns null when the row carries no defensive stats to score. Exported for the test suite. */
export function defenseFantasyPoints(entry: Record<string, unknown>): number | null {
  const present = [
    'sacks',
    'defSack',
    'defensiveInterceptions',
    'interceptions',
    'defInt',
    'fumblesRecovered',
    'fumbleRecoveries',
    'defTD',
    'ptsAllowed',
    'ptsAgainst'
  ].some((key) => optionalNum(entry[key]) !== null);
  if (!present) return null;

  const total =
    firstNum(entry, ['sacks', 'defSack']) * DST_WEIGHTS.sack +
    firstNum(entry, ['defensiveInterceptions', 'interceptions', 'defInt']) * DST_WEIGHTS.interception +
    firstNum(entry, ['fumblesRecovered', 'fumbleRecoveries', 'defFumblesRecovered']) *
      DST_WEIGHTS.fumbleRecovery +
    (firstNum(entry, ['defTD']) + firstNum(entry, ['returnTD'])) * DST_WEIGHTS.touchdown +
    firstNum(entry, ['safeties', 'defSafety']) * DST_WEIGHTS.safety +
    firstNum(entry, ['blockKick', 'blockedKick']) * DST_WEIGHTS.blockedKick +
    pointsAllowedBonus(firstNum(entry, ['ptsAllowed', 'ptsAgainst']));

  return Math.round(total * 100) / 100;
}

/**
 * A team's abbreviation, wherever this payload keeps it. The live
 * `teamDefenseProjections` node is keyed by numeric teamID — not by
 * abbreviation, as the shape of the box score's `DST` node suggests — so reading
 * the key produced rows like `DST-10` for team "10". Both payloads do carry
 * `teamAbv`, so that comes first, and a numeric key is only ever a last resort.
 */
function defenseTeamAbbr(entry: Record<string, unknown>): string | null {
  const explicit = text(entry.teamAbv) ?? text(entry.team);
  if (explicit && !/^\d+$/.test(explicit)) return teamAbbr(explicit, explicit);

  const key = text(entry.__key);
  if (key && !/^\d+$/.test(key) && !/^(home|away)$/i.test(key)) return teamAbbr(key, key);
  return null;
}

/** Tank01 wraps everything in `{ statusCode, body }`; some hosts do not. */
function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'body' in payload) {
    return (payload as { body: unknown }).body;
  }
  return payload;
}

/** Body arrives either as an array or as an object keyed by id — both happen. */
function asRecords(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
  if (body && typeof body === 'object') {
    return Object.entries(body as Record<string, unknown>)
      .filter(([, value]) => !!value && typeof value === 'object' && !Array.isArray(value))
      .map(([key, value]) => ({ __key: key, ...(value as Record<string, unknown>) }));
  }
  return [];
}

/** byeWeeks: { "2026": ["7"] } -> 7 */
function byeWeek(value: unknown, season: number): number | null {
  if (!value || typeof value !== 'object') return null;
  const table = value as Record<string, unknown>;
  const candidate = table[String(season)] ?? Object.values(table)[0];
  if (Array.isArray(candidate)) return optionalNum(candidate[0]);
  return optionalNum(candidate);
}

/** '20251005_CHI@MIN' -> { away: 'CHI', home: 'MIN' } */
function teamsFromGameId(gameId: string | null): { away: string | null; home: string | null } {
  if (!gameId) return { away: null, home: null };
  const match = /_([A-Z]{2,4})@([A-Z]{2,4})$/.exec(gameId.toUpperCase());
  return match ? { away: match[1], home: match[2] } : { away: null, home: null };
}

export interface Tank01Options {
  env: SportsDataEnv;
  http?: HttpClient;
  logger?: Logger;
  /** Overrides the provider name reported in logs and sync_runs rows. */
  name?: string;
}

export function createTank01Provider(options: Tank01Options): SportsDataProvider {
  const { env } = options;
  const logger = options.logger ?? silentLogger;
  const name = options.name ?? TANK01_PROVIDER_NAME;
  const endpoints = env.endpoints;

  const http =
    options.http ??
    createHttpClient(env.baseUrl, {
      headers: {
        [env.apiKeyHeader]: env.apiKey,
        [env.apiHostHeader]: env.apiHost
      },
      timeoutMs: env.timeoutMs,
      maxRetries: env.maxRetries,
      retryBaseMs: env.retryBaseMs,
      rateLimitMs: env.rateLimitMs,
      logger
    });

  function requireCredentials(): void {
    if (options.http) return; // injected transport (fixtures, tests) needs no key
    const missing: string[] = [];
    if (!env.apiKey) missing.push('SPORTS_DATA_API_KEY');
    if (!env.apiHost && !env.baseUrl) missing.push('SPORTS_DATA_API_HOST');
    if (missing.length) {
      throw new Error(
        `${name}: missing ${missing.join(' and ')} — set them, or run with SPORTS_DATA_PROVIDER=fixture.`
      );
    }
  }

  async function get(endpoint: string, query: Record<string, string | number | undefined> = {}) {
    requireCredentials();
    const path = endpoints[endpoint];
    if (!path) throw new Error(`${name}: no endpoint configured for "${endpoint}"`);
    const response = await http.getJson(path, query);
    return unwrap(response.json);
  }

  function describe(): ProviderDescription {
    return {
      name,
      host: env.apiHost || null,
      endpoints: { ...endpoints },
      configured: Boolean(options.http) || Boolean(env.apiKey && (env.apiHost || env.baseUrl)),
      notes: options.http ? ['transport injected — no network calls'] : undefined
    };
  }

  /* ------------------------------------------------------------------ teams */

  async function fetchTeams(context: ProviderContext): Promise<TeamRow[]> {
    const body = await get('teams', {
      rosters: 'false',
      schedules: 'false',
      topPerformers: 'false',
      teamStats: 'false'
    });

    return asRecords(body)
      .map((row): TeamRow | null => {
        const externalId = text(row.teamID) ?? text(row.__key);
        const abbr = text(row.teamAbv) ?? text(row.abbreviation);
        if (!externalId || !abbr) return null;
        return {
          external_id: externalId,
          abbr: teamAbbr(abbr, abbr),
          city: text(row.teamCity),
          name: text(row.teamName),
          conference: text(row.conference) ?? text(row.conferenceAbv),
          division: text(row.division),
          bye_week: byeWeek(row.byeWeeks, context.season),
          logo_url: text(row.espnLogo1) ?? text(row.nflComLogo1),
          raw: row
        };
      })
      .filter((row): row is TeamRow => row !== null);
  }

  /* ---------------------------------------------------------------- players */

  function mapRosterPlayer(
    row: Record<string, unknown>,
    fallbackTeam: string | null,
    fallbackTeamId: string | null,
    bye: number | null
  ): PlayerRow | null {
    const externalId = text(row.playerID) ?? text(row.__key);
    const name = text(row.longName) ?? text(row.espnName) ?? text(row.cbsShortName);
    const position = fantasyPosition(row.pos ?? row.position);
    if (!externalId || !name || !position) return null;

    const injury = (row.injury && typeof row.injury === 'object' ? row.injury : {}) as Record<
      string,
      unknown
    >;

    // A present, empty team field is an explicit free-agent signal. Otherwise
    // the containing active roster outranks an embedded historical team code.
    const hasTeam = Object.hasOwn(row, 'teamAbv') || Object.hasOwn(row, 'team');
    const reportedTeam = Object.hasOwn(row, 'teamAbv') ? row.teamAbv : row.team;
    const explicit = hasTeam ? teamAbbr(reportedTeam) : null;
    const team = explicit === 'FA' ? 'FA' : teamAbbr(fallbackTeam ?? explicit);

    return {
      external_id: externalId,
      name,
      position,
      team,
      nfl_team_external_id: team === 'FA' ? null : fallbackTeamId ?? text(row.teamID),
      jersey: text(row.jerseyNum),
      status: team === 'FA' ? 'Free Agent' : text(injury.designation) ?? text(row.status) ?? 'Active',
      injury,
      bye_week: bye,
      age: optionalNum(row.age),
      experience: text(row.exp),
      college: text(row.school) ?? text(row.college),
      adp: null,
      stats: {},
      raw: row
    };
  }

  /**
   * Players *and* rosters in one request: `getNFLTeams?rosters=true` returns each
   * franchise with its roster keyed by playerID, so a player's team assignment
   * comes from the roster it appears on rather than a second lookup. Falls back
   * to the flat player list when a host does not support the rosters flag.
   */
  async function fetchPlayers(context: ProviderContext): Promise<PlayerRow[]> {
    const body = await get('teams', {
      rosters: 'true',
      schedules: 'false',
      topPerformers: 'false',
      teamStats: 'false'
    });

    const teams = asRecords(body);
    const players: PlayerRow[] = [];
    const seen = new Set<string>();

    if (teams.length === 32 && teams.some((team) => asRecords(team.Roster ?? team.roster).length === 0)) {
      throw new Error('incomplete NFL roster snapshot: a franchise has no roster entries');
    }

    for (const team of teams) {
      const abbr = text(team.teamAbv);
      const teamId = text(team.teamID);
      const bye = byeWeek(team.byeWeeks, context.season);
      const roster = team.Roster ?? team.roster;
      for (const entry of asRecords(roster)) {
        const player = mapRosterPlayer(entry, abbr, teamId, bye);
        if (!player || seen.has(player.external_id)) continue;
        seen.add(player.external_id);
        players.push(player);
      }
    }

    if (players.length > 0) {
      logger.debug('mapped rosters', { teams: teams.length, players: players.length });
      return players;
    }

    logger.warn('no rosters in teams payload — falling back to the flat player list');
    const list = await get('playerList');
    for (const entry of asRecords(list)) {
      const player = mapRosterPlayer(entry, null, null, null);
      if (!player || seen.has(player.external_id)) continue;
      seen.add(player.external_id);
      players.push(player);
    }
    return players;
  }

  /* ------------------------------------------------------------ projections */

  async function fetchProjections(context: ProviderContext): Promise<ProjectionRow[]> {
    const week = assertWeek(context.week, 'week');
    const body = await get('projections', {
      week,
      archiveSeason: context.season,
      ...scoringQuery(context.scoringFormat)
    });

    const envelope = (body ?? {}) as Record<string, unknown>;
    const source = endpoints.projections;
    const rows: ProjectionRow[] = [];

    const base = {
      season: context.season,
      week,
      season_type: context.seasonType,
      scoring_format: context.scoringFormat,
      source
    };

    for (const entry of asRecords(envelope.playerProjections ?? envelope)) {
      const externalId = text(entry.playerID) ?? text(entry.__key);
      if (!externalId) continue;
      const stats = statsOf(entry);
      rows.push({
        ...base,
        external_player_id: externalId,
        player_id: `${name}-${externalId}`,
        name: text(entry.longName) ?? text(entry.espnName),
        position: text(entry.pos) ?? text(entry.position),
        team: text(entry.team) ? teamAbbr(entry.team) : null,
        // The live projections feed carries no opponent; fsnv2_sync_projections
        // derives it from fsnv2.nfl_matchups on the way in (migration 0005).
        opponent: text(entry.opponent) ? teamAbbr(entry.opponent) : null,
        fantasy_points: fantasyPointsOf(entry, context.scoringFormat),
        stats,
        raw: entry
      });
    }

    // Team defenses have their own node, keyed by numeric teamID.
    for (const entry of asRecords(envelope.teamDefenseProjections)) {
      const abbr = defenseTeamAbbr(entry);
      if (!abbr) {
        logger.warn('skipping a team defense projection with no resolvable team', {
          key: text(entry.__key)
        });
        continue;
      }
      const stats = statsOf(entry);
      const provided = fantasyPointsOf(entry, context.scoringFormat);
      rows.push({
        ...base,
        external_player_id: `DST-${abbr}`,
        player_id: null,
        name: `${abbr} D/ST`,
        position: 'DST',
        team: abbr,
        opponent: text(entry.opponent) ? teamAbbr(entry.opponent) : null,
        fantasy_points: provided || (defenseFantasyPoints(entry) ?? 0),
        stats,
        raw: entry
      });
    }

    return rows;
  }

  /* -------------------------------------------------------------- schedules */

  function mapGame(row: Record<string, unknown>, context: ProviderContext, week: number): GameRow | null {
    const externalId = text(row.gameID) ?? text(row.__key);
    if (!externalId) return null;

    const fromId = teamsFromGameId(externalId);
    const home = text(row.home) ?? text(row.homeTeam) ?? fromId.home;
    const away = text(row.away) ?? text(row.awayTeam) ?? fromId.away;
    if (!home || !away) return null;

    const status = gameStatus(row.gameStatus ?? row.status);
    return {
      external_id: externalId,
      season: optionalNum(row.season) ?? context.season,
      week: optionalNum(row.gameWeek ? String(row.gameWeek).replace(/\D+/g, '') : null) ?? week,
      season_type: context.seasonType,
      home_team: teamAbbr(home, home),
      away_team: teamAbbr(away, away),
      home_score: optionalNum(row.homePts),
      away_score: optionalNum(row.awayPts),
      kickoff: kickoffIso({
        epoch: row.gameTime_epoch,
        iso: row.gameTimeISO,
        date: row.gameDate,
        time: row.gameTime
      }),
      status,
      venue: text(row.venue) ?? text(row.stadium),
      neutral_site: row.neutralSite === true || text(row.neutralSite)?.toLowerCase() === 'true',
      source: endpoints.games,
      raw: row
    };
  }

  async function fetchWeekGames(context: ProviderContext, week: number): Promise<GameRow[]> {
    const body = await get('games', {
      week,
      season: context.season,
      seasonType: context.seasonType
    });
    return asRecords(body)
      .map((row) => mapGame(row, context, week))
      .filter((row): row is GameRow => row !== null);
  }

  async function fetchSchedules(context: ProviderContext): Promise<GameRow[]> {
    const weeks =
      context.weeks && context.weeks.length > 0
        ? context.weeks.map((week) => assertWeek(week, 'week'))
        : context.week
          ? [assertWeek(context.week, 'week')]
          : Array.from({ length: env.scheduleWeeks }, (_, index) => index + 1);

    const games: GameRow[] = [];
    const seen = new Set<string>();
    for (const week of weeks) {
      // Sequential on purpose: RapidAPI plans are rate-limited per second.
      // eslint-disable-next-line no-await-in-loop
      const weekGames = await fetchWeekGames(context, week);
      for (const game of weekGames) {
        if (seen.has(game.external_id)) continue;
        seen.add(game.external_id);
        games.push(game);
      }
      logger.debug('mapped week schedule', { week, games: weekGames.length });
    }
    return games;
  }

  /* ------------------------------------------------------------- box scores */

  function mapBoxScorePlayer(
    entry: Record<string, unknown>,
    context: ProviderContext,
    week: number,
    gameId: string,
    teams: { home: string | null; away: string | null }
  ): WeeklyStatRow | null {
    const externalId = text(entry.playerID) ?? text(entry.__key);
    if (!externalId) return null;

    const team = text(entry.teamAbv) ?? text(entry.team);
    const opponent =
      team && teams.home && teams.away
        ? teamAbbr(team) === teamAbbr(teams.home)
          ? teamAbbr(teams.away)
          : teamAbbr(teams.home)
        : null;

    const snapCounts = (
      entry.snapCounts && typeof entry.snapCounts === 'object' ? entry.snapCounts : {}
    ) as Record<string, unknown>;
    const stats: StatLine = statsOf(entry);

    return {
      external_player_id: externalId,
      player_id: `${name}-${externalId}`,
      season: context.season,
      week,
      season_type: context.seasonType,
      game_external_id: gameId,
      name: text(entry.longName) ?? text(entry.espnName),
      // Box-score entries carry no position; fsnv2_sync_weekly_stats fills it
      // from the synced player pool on the way in (migration 0005).
      position: text(entry.pos) ?? text(entry.position),
      team: team ? teamAbbr(team) : null,
      opponent,
      fantasy_points: fantasyPointsOf(entry, context.scoringFormat),
      stats,
      snap_counts: flattenStats(snapCounts),
      source: endpoints.boxScore,
      raw: entry
    };
  }

  /**
   * One week of real results: the week's games, then a box score per game. Team
   * defenses are read from the game's `DST` node so K/DST scoring lands too.
   */
  async function fetchBoxScores(context: ProviderContext): Promise<WeeklyStatRow[]> {
    const week = assertWeek(context.week, 'week');
    const games = await fetchWeekGames(context, week);
    const playable = games
      .filter((game) => game.status !== 'canceled' && game.status !== 'postponed')
      .slice(0, env.maxGamesPerWeek);

    const rows: WeeklyStatRow[] = [];
    const seen = new Set<string>();

    for (const game of playable) {
      // eslint-disable-next-line no-await-in-loop
      const body = await get('boxScore', {
        gameID: game.external_id,
        playByPlay: 'false',
        fantasyPoints: 'true',
        ...scoringQuery(context.scoringFormat)
      });

      const envelope = (body ?? {}) as Record<string, unknown>;
      const teams = { home: game.home_team, away: game.away_team };

      for (const entry of asRecords(envelope.playerStats)) {
        const row = mapBoxScorePlayer(entry, context, week, game.external_id, teams);
        if (!row || seen.has(row.external_player_id)) continue;
        seen.add(row.external_player_id);
        rows.push(row);
      }

      // The box score's DST node is keyed 'home'/'away' and carries only raw
      // defensive stats, so the fantasy total is computed here.
      for (const entry of asRecords(envelope.DST)) {
        const abbr = defenseTeamAbbr(entry);
        if (!abbr) continue;
        const externalId = `DST-${abbr}`;
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        const stats = statsOf(entry);
        const provided = fantasyPointsOf(entry, context.scoringFormat);
        rows.push({
          external_player_id: externalId,
          player_id: null,
          season: context.season,
          week,
          season_type: context.seasonType,
          game_external_id: game.external_id,
          name: `${abbr} D/ST`,
          position: 'DST',
          team: abbr,
          opponent: abbr === teamAbbr(game.home_team) ? game.away_team : game.home_team,
          fantasy_points: provided || (defenseFantasyPoints(entry) ?? 0),
          stats,
          snap_counts: {},
          source: endpoints.boxScore,
          raw: entry
        });
      }

      logger.debug('mapped box score', { game: game.external_id, rows: rows.length });
    }

    return rows;
  }

  return {
    name,
    describe,
    fetchTeams,
    fetchPlayers,
    fetchProjections,
    fetchBoxScores,
    fetchSchedules
  };
}
