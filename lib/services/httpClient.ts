/**
 * httpClient.ts
 * -----------------------------------------------------------------------------
 * The one place that talks to the network: JSON GETs with a timeout, bounded
 * exponential-backoff retries on the failures worth retrying (429, 5xx, socket
 * errors), and an optional fixed delay between calls for rate-limited plans.
 *
 * `fetch` is injected, which is what lets the fixture provider and the test
 * suite run the real mapping code with no network at all.
 */

import type { Logger } from './logger.ts';
import { silentLogger } from './logger.ts';

export class HttpError extends Error {
  status: number;
  url: string;
  body: string;

  constructor(message: string, status: number, url: string, body = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  fetch?: FetchLike;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  rateLimitMs?: number;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export interface JsonResponse<T = unknown> {
  url: string;
  status: number;
  json: T;
  durationMs: number;
}

export interface HttpClient {
  getJson<T = unknown>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<JsonResponse<T>>;
  readonly calls: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | number | boolean | undefined> = {}
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const url = new URL(suffix);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function createHttpClient(baseUrl: string, options: HttpClientOptions = {}): HttpClient {
  const doFetch = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
  const logger = options.logger ?? silentLogger;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxRetries = options.maxRetries ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const rateLimitMs = options.rateLimitMs ?? 0;

  if (!doFetch) {
    throw new Error('No fetch implementation available — pass options.fetch.');
  }
  const fetchJson: FetchLike = doFetch;

  let calls = 0;
  let lastCallAt = 0;

  async function throttle(): Promise<void> {
    if (!rateLimitMs) return;
    const wait = rateLimitMs - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
  }

  async function getJson<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {}
  ): Promise<JsonResponse<T>> {
    const url = buildUrl(baseUrl, path, query);
    let attempt = 0;

    for (;;) {
      await throttle();
      const startedAt = Date.now();
      calls += 1;
      lastCallAt = startedAt;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetchJson(url, {
            method: 'GET',
            headers: { accept: 'application/json', ...(options.headers ?? {}) },
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }

        const durationMs = Date.now() - startedAt;

        if (!response.ok) {
          const body = (await response.text().catch(() => '')).slice(0, 500);
          const error = new HttpError(
            `GET ${path} failed (${response.status})${body ? `: ${body}` : ''}`,
            response.status,
            url,
            body
          );
          if (RETRYABLE.has(response.status) && attempt < maxRetries) {
            const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
            const delay = Number.isFinite(retryAfter)
              ? retryAfter * 1000
              : retryBaseMs * 2 ** attempt;
            logger.warn('provider request failed, retrying', {
              path,
              status: response.status,
              attempt: attempt + 1,
              delay_ms: delay
            });
            attempt += 1;
            await sleep(delay);
            continue;
          }
          throw error;
        }

        const json = (await response.json()) as T;
        logger.debug('provider request ok', { path, status: response.status, ms: durationMs });
        return { url, status: response.status, json, durationMs };
      } catch (error) {
        const isHttp = error instanceof HttpError;
        if (isHttp || attempt >= maxRetries) throw error;
        const delay = retryBaseMs * 2 ** attempt;
        logger.warn('provider request errored, retrying', {
          path,
          attempt: attempt + 1,
          delay_ms: delay,
          error: (error as Error).message
        });
        attempt += 1;
        await sleep(delay);
      }
    }
  }

  return {
    getJson,
    get calls() {
      return calls;
    }
  };
}
