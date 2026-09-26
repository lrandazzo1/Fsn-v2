/**
 * gameLock.d.ts
 * -----------------------------------------------------------------------------
 * Types for js/gameLock.js, which is written as a plain ES module so the
 * browser, the Node test-suite and the Vercel Functions can all import the one
 * implementation (see the header of that file). This declaration is what lets
 * the `.ts` modules under lib/ do so without `allowJs`, and it is the contract
 * to keep in step if a signature there changes.
 */

export type GameStatusName = 'scheduled' | 'in_progress' | 'final' | 'postponed' | 'canceled';

export type LockReason =
  | 'started'
  | 'in_progress'
  | 'final'
  | 'scheduled'
  | 'bye'
  | 'unknown'
  | 'postponed'
  | 'canceled';

/** Any game object a feed might hand us — Tank01, Sleeper, or our own GameRow. */
export type GameLike = Record<string, unknown>;

/** Any player-ish object: ours carries `team`, Tank01's carries `teamAbv`. */
export type PlayerLike = Record<string, unknown> | string | null | undefined;

export interface GameSchedule {
  games: GameLike[];
  byTeam: Map<string, GameLike>;
  isGameSchedule: true;
}

export interface LockState {
  locked: boolean;
  reason: LockReason;
  status: GameStatusName | null;
  kickoff: number | null;
  game: GameLike | null;
  team: string | null;
}

export const GAME_STATUSES: GameStatusName[];
export const LOCKED_GAME_STATUSES: GameStatusName[];

export function normalizeGameStatus(value: unknown): GameStatusName | null;
export function gameStatusOf(game: GameLike | null | undefined): GameStatusName | null;
export function isLockedStatus(status: unknown): boolean;

export function epochMs(value: unknown): number | null;
export function easternOffsetHours(month: number, day: number): number;
export function parseKickoff(input: {
  epoch?: unknown;
  iso?: unknown;
  date?: unknown;
  time?: unknown;
}): number | null;
export function gameStartTimestamp(game: GameLike | null | undefined): number | null;

export function playerTeamAbbr(player: PlayerLike): string | null;
export function playerName(player: PlayerLike): string;
export function gameTeams(game: GameLike | null | undefined): string[];

export function normalizeGames(payload: unknown): GameLike[];
export function buildGameSchedule(payload: unknown): GameSchedule;
export function gameForPlayer(player: PlayerLike, gameSchedule: unknown): GameLike | null;

export function playerLockState(player: PlayerLike, gameSchedule: unknown, now?: number): LockState;
export function isPlayerLocked(player: PlayerLike, gameSchedule: unknown, now?: number): boolean;
export function lockedPlayerMessage(player: PlayerLike): string;
export function lockLabel(state: LockState): string;
export function rosterLockStates(
  roster: Record<string, string | null> | null | undefined,
  playersById: Record<string, Record<string, unknown>>,
  gameSchedule: unknown,
  now?: number
): Map<string, LockState>;

export function setLockSchedule(byWeek: Map<number, GameLike[]> | null): number;
export function hasLockSchedule(week: number): boolean;
export function lockScheduleWeeks(): number[];
export function lockScheduleFor(week: number): GameSchedule;
export function isLockedInWeek(player: PlayerLike, week: number, now?: number): boolean;
export function lockStateInWeek(player: PlayerLike, week: number, now?: number): LockState;
export function rosterLocksInWeek(
  roster: Record<string, string | null> | null | undefined,
  playersById: Record<string, Record<string, unknown>>,
  week: number,
  now?: number
): Map<string, LockState>;
