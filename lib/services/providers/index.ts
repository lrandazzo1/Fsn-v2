/**
 * providers/index.ts
 * -----------------------------------------------------------------------------
 * The provider registry — the swap point named by `SPORTS_DATA_PROVIDER`.
 *
 *   SPORTS_DATA_PROVIDER=tank01    Tank01 / generic RapidAPI (default)
 *   SPORTS_DATA_PROVIDER=fixture   recorded payloads from lib/fixtures (no network)
 *
 * Adding a vendor is one file plus one `registerProvider()` call; nothing in the
 * database, the RPC surface or the UI moves.
 */

import type { Logger } from '../logger.ts';
import { silentLogger } from '../logger.ts';
import { createHttpClient } from '../httpClient.ts';
import type { FetchLike, HttpClient } from '../httpClient.ts';
import type { SportsDataEnv } from '../env.ts';
import type { SportsDataProvider } from '../types.ts';
import { TANK01_PROVIDER_NAME, createTank01Provider } from './tank01.ts';
import { createFixtureFetch } from './fixtureTransport.ts';

export interface ProviderDeps {
  env: SportsDataEnv;
  logger?: Logger;
  /** Replaces the network for this provider (fixtures, tests, a proxy). */
  fetch?: FetchLike;
  http?: HttpClient;
}

export type ProviderFactory = (deps: ProviderDeps) => SportsDataProvider;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  registry.set(name.toLowerCase(), factory);
}

export function listProviders(): string[] {
  return [...registry.keys()].sort();
}

export function hasProvider(name: string): boolean {
  return registry.has(name.toLowerCase());
}

registerProvider(TANK01_PROVIDER_NAME, ({ env, logger, fetch, http }) => {
  const transport =
    http ??
    (fetch
      ? createHttpClient(env.baseUrl || 'https://sports-data.invalid', {
          fetch,
          headers: { [env.apiKeyHeader]: env.apiKey, [env.apiHostHeader]: env.apiHost },
          timeoutMs: env.timeoutMs,
          maxRetries: env.maxRetries,
          retryBaseMs: env.retryBaseMs,
          logger: logger ?? silentLogger
        })
      : undefined);

  return createTank01Provider({ env, logger, http: transport });
});

// The fixture provider *is* the Tank01 provider with a disk-backed transport, so
// the recorded payloads run through the production mapper.
registerProvider('fixture', ({ env, logger, fetch, http }) => {
  const transport =
    http ??
    createHttpClient('https://fixtures.fsn.local', {
      fetch: fetch ?? createFixtureFetch({ dir: env.fixtureDir }),
      timeoutMs: env.timeoutMs,
      maxRetries: 0,
      logger: logger ?? silentLogger
    });

  return createTank01Provider({ env, logger, http: transport, name: 'fixture' });
});

export function resolveProvider(deps: ProviderDeps): SportsDataProvider {
  const name = (deps.env.provider || TANK01_PROVIDER_NAME).toLowerCase();
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown SPORTS_DATA_PROVIDER "${name}". Registered providers: ${listProviders().join(', ')}.`
    );
  }
  return factory(deps);
}

export { createTank01Provider, TANK01_PROVIDER_NAME } from './tank01.ts';
export { createFixtureFetch, resolveFixtureDir, REPO_ROOT } from './fixtureTransport.ts';
