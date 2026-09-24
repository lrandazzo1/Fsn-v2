/**
 * providers/fixtureTransport.ts
 * -----------------------------------------------------------------------------
 * A `fetch` that serves recorded provider payloads from disk.
 *
 * The point is that the *fixture provider is the real provider*: the Tank01
 * mapper runs unchanged over these files, so `npm run test:sync-data` exercises
 * the production mapping, batching and upsert code with no API key and no
 * network — and a mapping bug fails the test rather than surfacing at 3am in a
 * cron job.
 *
 * Lookup order for `GET https://host/getNFLBoxScore?gameID=20260913_CHI@MIN`:
 *   1. getNFLBoxScore.20260913_CHI@MIN.json   (per-argument capture)
 *   2. getNFLBoxScore.rosters.json            (flag-specific capture, rosters=true)
 *   3. getNFLBoxScore.json                    (the generic capture)
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FetchLike } from '../httpClient.ts';

/** Repo root, so fixtures resolve the same from any working directory. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export interface FixtureTransportOptions {
  dir?: string;
  /** Called with every resolved fixture path — handy for assertions in tests. */
  onRequest?: (info: { endpoint: string; file: string | null; url: string }) => void;
}

function candidates(endpoint: string, url: URL): string[] {
  const names = [`${endpoint}.json`];

  const gameId = url.searchParams.get('gameID');
  if (gameId) names.unshift(`${endpoint}.${gameId}.json`);

  const week = url.searchParams.get('week');
  if (week) names.unshift(`${endpoint}.week${week}.json`);

  if (url.searchParams.get('rosters') === 'true') names.unshift(`${endpoint}.rosters.json`);

  return names;
}

export function resolveFixtureDir(dir: string): string {
  return isAbsolute(dir) ? dir : join(REPO_ROOT, dir);
}

export function createFixtureFetch(options: FixtureTransportOptions = {}): FetchLike {
  const dir = resolveFixtureDir(options.dir ?? 'lib/fixtures/tank01');

  return async function fixtureFetch(input: string): Promise<Response> {
    const url = new URL(input);
    const endpoint = url.pathname.replace(/^\/+/, '').split('/').pop() ?? '';

    let file: string | null = null;
    for (const candidate of candidates(endpoint, url)) {
      const path = join(dir, candidate);
      if (existsSync(path)) {
        file = path;
        break;
      }
    }

    options.onRequest?.({ endpoint, file, url: input });

    if (!file) {
      return new Response(
        JSON.stringify({
          statusCode: 404,
          error: `no fixture for "${endpoint}" in ${dir}`
        }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response(readFileSync(file, 'utf8'), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}
