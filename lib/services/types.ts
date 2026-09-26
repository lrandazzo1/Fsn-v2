/**
 * types.ts
 * -----------------------------------------------------------------------------
 * The provider-agnostic vocabulary of the ingestion layer.
 *
 * Everything below `SportsDataProvider` is *our* shape, not a vendor's: a
 * provider's only job is to turn its own JSON into these rows, which map 1:1
 * onto the columns the `fsnv2_sync_*` RPCs write (see
 * supabase/migrations/0004_fsnv2_sports_data_sync.sql). Swapping providers
 * therefore never reaches the database, and never reaches the UI.
 */

export type SyncTask = 'players_rosters' | 'weekly_projections' | 'box_scores' | 'schedules';

export type SeasonType = 'pre' | 'reg' | 'post';

export type ScoringFormat = 'standard' | 'half_ppr' | 'ppr' | 'superflex' | 'custom';

/** The six positions fsnv2.players carries. Anything else is skipped on write. */
export type FantasyPosition = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST';

export type GameStatus = 'scheduled' | 'in_progress' | 'final' | 'postponed' | 'canceled';

export type RunStatus = 'running' | 'success' | 'partial' | 'error';

/** A record of arbitrary numeric stat keys — whatever the provider published. */
export type StatLine = Record<string, number>;

export interface TeamRow {
  external_id: string;
  abbr: string;
  city?: string | null;
  name?: string | null;
  conference?: string | null;
  division?: string | null;
  bye_week?: number | null;
  logo_url?: string | null;
  raw?: unknown;
}

export interface PlayerRow {
  /** Provider's stable id. Our row id becomes `<provider>-<external_id>`. */
  external_id: string;
  name: string;
  position: FantasyPosition;
  /**
   * One of the 32 canonical abbreviations (lib/services/teams.ts), or 'FA' when
   * the payload named no franchise. 'FA' is read by `fsnv2_sync_players` as "the
   * provider did not say" and leaves a stored team alone, so a mapper that
   * cannot resolve a team never overwrites a good assignment with a bad one.
   */
  team: string;
  nfl_team_external_id?: string | null;
  jersey?: string | null;
  status?: string | null;
  injury?: Record<string, unknown>;
  bye_week?: number | null;
  age?: number | null;
  experience?: string | null;
  college?: string | null;
  adp?: number | null;
  stats?: Record<string, unknown>;
  /* Cross-feed identity — what the player audit reconciles on. A provider that
   * publishes none of these is matched by normalized name + position instead. */
  espn_id?: string | null;
  sleeper_id?: string | null;
  gsis_id?: string | null;
  rotowire_id?: string | null;
  headshot_url?: string | null;
  raw?: unknown;
}

export interface ProjectionRow {
  external_player_id: string;
  player_id?: string | null;
  season: number;
  week: number;
  season_type: SeasonType;
  scoring_format: ScoringFormat;
  name?: string | null;
  position?: string | null;
  team?: string | null;
  opponent?: string | null;
  fantasy_points: number;
  stats: StatLine;
  source?: string | null;
  raw?: unknown;
}

export interface WeeklyStatRow {
  external_player_id: string;
  player_id?: string | null;
  season: number;
  week: number;
  season_type: SeasonType;
  game_external_id?: string | null;
  name?: string | null;
  position?: string | null;
  team?: string | null;
  opponent?: string | null;
  fantasy_points: number;
  stats: StatLine;
  snap_counts?: StatLine;
  source?: string | null;
  raw?: unknown;
}

export interface GameRow {
  external_id: string;
  season: number;
  week: number;
  season_type: SeasonType;
  home_team: string;
  away_team: string;
  home_score?: number | null;
  away_score?: number | null;
  /** ISO-8601 kickoff, UTC. */
  kickoff?: string | null;
  status: GameStatus;
  venue?: string | null;
  neutral_site?: boolean;
  source?: string | null;
  raw?: unknown;
}

/** What a provider is told about the season/week it is being asked for. */
export interface ProviderContext {
  season: number;
  seasonType: SeasonType;
  scoringFormat: ScoringFormat;
  week?: number;
  /** Weeks to pull when a task covers a range (schedules). */
  weeks?: number[];
}

export interface ProviderDescription {
  name: string;
  host: string | null;
  endpoints: Record<string, string>;
  /** False when the provider is missing credentials and cannot be called. */
  configured: boolean;
  notes?: string[];
}

/**
 * The seam the whole feature turns on. A new vendor means one new file that
 * implements this interface and one `registerProvider()` call — no schema
 * change, no UI change, no SQL change.
 */
export interface SportsDataProvider {
  readonly name: string;
  describe(): ProviderDescription;
  fetchTeams(context: ProviderContext): Promise<TeamRow[]>;
  fetchPlayers(context: ProviderContext): Promise<PlayerRow[]>;
  fetchProjections(context: ProviderContext): Promise<ProjectionRow[]>;
  fetchBoxScores(context: ProviderContext): Promise<WeeklyStatRow[]>;
  fetchSchedules(context: ProviderContext): Promise<GameRow[]>;
}

export interface UpsertCount {
  inserted: number;
  updated: number;
  skipped: number;
  total: number;
}

export interface SyncRunLog {
  task: SyncTask;
  provider: string;
  status: RunStatus;
  season?: number | null;
  week?: number | null;
  fetched?: number;
  written?: number;
  skipped?: number;
  duration_ms?: number | null;
  error?: string | null;
  detail?: Record<string, unknown>;
}

/** What every sync method resolves to — success or failure. */
export interface SyncResult {
  task: SyncTask;
  provider: string;
  ok: boolean;
  season: number;
  week: number | null;
  /** Rows the provider returned. */
  fetched: number;
  /** Rows the database accepted (inserted + updated). */
  written: number;
  inserted: number;
  updated: number;
  /** Rows the database declined (unsupported position, duplicate in batch). */
  skipped: number;
  batches: number;
  durationMs: number;
  errors: string[];
  /** fsnv2.sync_runs id, when the audit row was written. */
  runId: string | null;
  /** Task-specific extras — game count, weeks covered, table row counts. */
  detail: Record<string, unknown>;
}

/**
 * A row of `fsnv2.players` as the audit reads it — what
 * `fsnv2_players_audit_snapshot` returns. Provider-null rows are the
 * hand-maintained pool from js/playerData.js; they are in scope precisely
 * because they are the ones that drift.
 */
export interface PlayerAuditRow {
  id: string;
  name: string;
  position: string;
  team: string | null;
  provider?: string | null;
  external_id?: string | null;
  nfl_team_external_id?: string | null;
  gsis_id?: string | null;
  espn_id?: string | null;
  sleeper_id?: string | null;
  rotowire_id?: string | null;
  headshot_url?: string | null;
  jersey?: string | null;
  status?: string | null;
  team_source?: string | null;
  audited_at?: string | null;
}

/** What `fsnv2_apply_player_audit` reports back, per column it touched. */
export interface PlayerAuditApplyCount {
  matched: number;
  updated: number;
  /** Rows in the payload whose id is not in the table. */
  missing: number;
  total: number;
  teams: number;
  headshots: number;
  ids: number;
  jerseys: number;
  dry_run: boolean;
}

export interface SyncRepository {
  readonly target: string;
  upsertTeams(rows: TeamRow[]): Promise<UpsertCount>;
  upsertPlayers(rows: PlayerRow[]): Promise<UpsertCount>;
  upsertProjections(rows: ProjectionRow[]): Promise<UpsertCount>;
  upsertWeeklyStats(rows: WeeklyStatRow[]): Promise<UpsertCount>;
  upsertSchedules(rows: GameRow[]): Promise<UpsertCount>;
  logRun(entry: SyncRunLog): Promise<string | null>;
  status(limit?: number): Promise<unknown>;
  /* The player audit's two halves — read the table, write the reconciled plan.
   * Optional so a repository double (or the dry-run one) need not implement them. */
  playersAuditSnapshot?(limit?: number): Promise<PlayerAuditRow[]>;
  applyPlayerAudit?(
    rows: Array<Record<string, string | null>>,
    dryRun?: boolean
  ): Promise<PlayerAuditApplyCount>;
  auditStatus?(): Promise<unknown>;
}

export interface SportsDataService {
  readonly provider: string;
  describe(): ProviderDescription;
  healthCheck(): Promise<{ ok: boolean; provider: string; teams: number; errors: string[] }>;
  syncPlayersAndRosters(options?: SyncOptions): Promise<SyncResult>;
  syncWeeklyProjections(week: number, options?: SyncOptions): Promise<SyncResult>;
  syncBoxScores(week: number, options?: SyncOptions): Promise<SyncResult>;
  syncSchedules(options?: SyncOptions & { weeks?: number[] | number }): Promise<SyncResult>;
}

export interface SyncOptions {
  season?: number;
  seasonType?: SeasonType;
  scoringFormat?: ScoringFormat;
  /** Skip the database write and report what would have been written. */
  dryRun?: boolean;
}
