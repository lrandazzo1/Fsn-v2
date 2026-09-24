/**
 * env.ts
 * -----------------------------------------------------------------------------
 * Every knob the ingestion layer has, read from the environment in one place.
 *
 * The provider is chosen by `SPORTS_DATA_PROVIDER` alone, so swapping vendors is
 * a deploy-time variable change — no code edit, and nothing for the UI to know
 * about. Endpoint paths are overridable too (`SPORTS_DATA_ENDPOINT_*`), which is
 * what makes the default fetcher work against a generic RapidAPI host and not
 * only Tank01.
 */

import type { ScoringFormat, SeasonType } from './types.ts';

export type EnvSource = Record<string, string | undefined>;

export interface SportsDataEnv {
  provider: string;
  apiKey: string;
  apiHost: string;
  baseUrl: string;
  /** RapidAPI sends the key as `x-rapidapi-key`; a direct vendor may want another header. */
  apiKeyHeader: string;
  apiHostHeader: string;
  season: number;
  seasonType: SeasonType;
  scoringFormat: ScoringFormat;
  scheduleWeeks: number;
  batchSize: number;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  rateLimitMs: number;
  maxGamesPerWeek: number;
  fixtureDir: string;
  dryRun: boolean;
  logLevel: string;
  logJson: boolean;
  supabaseUrl: string;
  supabaseKey: string;
  supabaseKeySource: string;
  endpoints: Record<string, string>;
}

/** Same project as js/config.js, so the CLI works without a URL in the env. */
export const DEFAULT_SUPABASE_URL = 'https://opfrwtjqjciqpmajeqlr.supabase.co';

export const DEFAULT_ENDPOINTS: Record<string, string> = {
  teams: '/getNFLTeams',
  playerList: '/getNFLPlayerList',
  roster: '/getNFLTeamRoster',
  projections: '/getNFLProjections',
  games: '/getNFLGamesForWeek',
  boxScore: '/getNFLBoxScore'
};

const SEASON_TYPES: SeasonType[] = ['pre', 'reg', 'post'];
const SCORING_FORMATS: ScoringFormat[] = ['standard', 'half_ppr', 'ppr', 'superflex', 'custom'];

function str(source: EnvSource, key: string, fallback = ''): string {
  const value = source[key];
  return value === undefined || value === '' ? fallback : value.trim();
}

function int(source: EnvSource, key: string, fallback: number): number {
  const raw = str(source, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${key} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function bool(source: EnvSource, key: string, fallback = false): boolean {
  const raw = str(source, key).toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * The NFL season a date belongs to: the 2026 season runs Sep 2026 -> Feb 2027,
 * so anything before March still belongs to the previous season's year.
 */
export function currentSeason(now: Date = new Date()): number {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 2 ? year : year - 1;
}

function oneOf<T extends string>(value: string, allowed: T[], key: string, fallback: T): T {
  if (!value) return fallback;
  if (!allowed.includes(value as T)) {
    throw new TypeError(`${key} must be one of ${allowed.join(', ')} — got "${value}"`);
  }
  return value as T;
}

/** Collects SPORTS_DATA_ENDPOINT_BOX_SCORE -> endpoints.boxScore. */
function endpointOverrides(source: EnvSource): Record<string, string> {
  const endpoints = { ...DEFAULT_ENDPOINTS };
  for (const key of Object.keys(endpoints)) {
    const envKey = `SPORTS_DATA_ENDPOINT_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    const override = str(source, envKey);
    if (override) endpoints[key] = override;
  }
  return endpoints;
}

export function readEnv(source: EnvSource = process.env, now: Date = new Date()): SportsDataEnv {
  const apiHost = str(source, 'SPORTS_DATA_API_HOST');
  const baseUrl = str(source, 'SPORTS_DATA_BASE_URL', apiHost ? `https://${apiHost}` : '');

  const secretKey =
    str(source, 'SUPABASE_SERVICE_ROLE_KEY') ||
    str(source, 'SUPABASE_SECRET_KEY') ||
    str(source, 'SUPABASE_KEY');
  const publishableKey = str(source, 'SUPABASE_PUBLISHABLE_KEY');

  return {
    provider: str(source, 'SPORTS_DATA_PROVIDER', 'tank01').toLowerCase(),
    apiKey: str(source, 'SPORTS_DATA_API_KEY'),
    apiHost,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKeyHeader: str(source, 'SPORTS_DATA_API_KEY_HEADER', 'x-rapidapi-key'),
    apiHostHeader: str(source, 'SPORTS_DATA_API_HOST_HEADER', 'x-rapidapi-host'),
    season: int(source, 'SPORTS_DATA_SEASON', currentSeason(now)),
    seasonType: oneOf(str(source, 'SPORTS_DATA_SEASON_TYPE'), SEASON_TYPES, 'SPORTS_DATA_SEASON_TYPE', 'reg'),
    scoringFormat: oneOf(
      str(source, 'SPORTS_DATA_SCORING'),
      SCORING_FORMATS,
      'SPORTS_DATA_SCORING',
      'ppr'
    ),
    scheduleWeeks: int(source, 'SPORTS_DATA_SCHEDULE_WEEKS', 18),
    batchSize: Math.max(1, int(source, 'SPORTS_DATA_BATCH_SIZE', 120)),
    timeoutMs: int(source, 'SPORTS_DATA_TIMEOUT_MS', 15000),
    maxRetries: Math.max(0, int(source, 'SPORTS_DATA_MAX_RETRIES', 3)),
    retryBaseMs: Math.max(0, int(source, 'SPORTS_DATA_RETRY_BASE_MS', 500)),
    rateLimitMs: Math.max(0, int(source, 'SPORTS_DATA_RATE_LIMIT_MS', 0)),
    maxGamesPerWeek: Math.max(1, int(source, 'SPORTS_DATA_MAX_GAMES_PER_WEEK', 16)),
    fixtureDir: str(source, 'SPORTS_DATA_FIXTURE_DIR', 'lib/fixtures/tank01'),
    dryRun: bool(source, 'SPORTS_DATA_DRY_RUN'),
    logLevel: str(source, 'SPORTS_DATA_LOG_LEVEL', str(source, 'LOG_LEVEL', 'info')).toLowerCase(),
    logJson: bool(source, 'SPORTS_DATA_LOG_JSON'),
    supabaseUrl: str(source, 'SUPABASE_URL', DEFAULT_SUPABASE_URL).replace(/\/+$/, ''),
    supabaseKey: secretKey || publishableKey,
    supabaseKeySource: secretKey ? 'secret' : publishableKey ? 'publishable' : 'none',
    endpoints: endpointOverrides(source)
  };
}
