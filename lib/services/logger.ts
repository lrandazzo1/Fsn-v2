/**
 * logger.ts
 * -----------------------------------------------------------------------------
 * A dependency-free leveled logger. Human-readable lines by default; set
 * SPORTS_DATA_LOG_JSON=1 for one JSON object per line when the service runs
 * under a log collector.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: string;
  json?: boolean;
  bindings?: Record<string, unknown>;
  write?: (line: string) => void;
}

function normalizeLevel(level: string | undefined): LogLevel {
  const candidate = (level || 'info').toLowerCase();
  return (candidate in ORDER ? candidate : 'info') as LogLevel;
}

function format(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return /[\s"]/.test(value) ? JSON.stringify(value) : value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = normalizeLevel(options.level);
  const bindings = options.bindings ?? {};
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const json = options.json ?? false;

  function emit(at: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[at] < ORDER[level]) return;
    const merged = { ...bindings, ...fields };
    if (json) {
      write(JSON.stringify({ ts: new Date().toISOString(), level: at, msg: message, ...merged }));
      return;
    }
    const tail = Object.entries(merged)
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(' ');
    const stamp = new Date().toISOString().slice(11, 23);
    write(`${stamp} ${at.toUpperCase().padEnd(5)} ${message}${tail ? ` ${tail}` : ''}`);
  }

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (extra) =>
      createLogger({ ...options, level, bindings: { ...bindings, ...extra } })
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent', write: () => {} });
