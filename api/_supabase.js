/**
 * api/_supabase.js
 * -----------------------------------------------------------------------------
 * What every route that proxies a `public.fsnv2_*` RPC needs: the fetch, the
 * one retry for PostgREST's stale catalog, the environment lookup, the cron
 * bearer check, and a single mapping from a Postgres error to an HTTP status.
 *
 * It is a support module, not an endpoint — Vercel does not route files under
 * `api/` whose name begins with an underscore, so this one is bundled with the
 * functions that import it and is not reachable on its own.
 *
 * It exists because api/roster/swap.js had grown all of this inline, and the
 * four routes added for waivers and trades would have been four more copies of
 * it. The error mapping in particular is worth having in one place: the
 * difference between "the migration is not applied" (503, and a message naming
 * the file) and "the league refused this" (409, and the database's own
 * sentence) is the difference between a deploy problem and a manager's problem,
 * and getting it wrong sends one to the other's inbox.
 */

/**
 * Missing-function / missing-column: the catalog copy PostgREST answers from is
 * stale. Both migrations end with `notify pgrst, 'reload schema'`, so this
 * clears itself within a moment — see `callRpc`.
 */
export const STALE_CACHE = new Set(['PGRST202', 'PGRST204']);

/** Postgres error codes the engines raise deliberately. */
const NOT_FOUND = 'P0002';   // league, draft, trade or bid does not exist
const REFUSED = 'P0001';     // the rules said no

export function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store');
  res.json(body);
}

/**
 * The service key, which is what these routes hold: processing the wire and
 * executing a trade are granted to `service_role` only (see the grants at the
 * foot of 0014). The publishable-key fallback is kept so a local run against a
 * project with the Phase-1 grants still answers rather than 503-ing, and it is
 * the read-only half that will work.
 */
export function credentials() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url, key } : null;
}

function post(url, key, name, args) {
  return fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify(args)
  });
}

/**
 * One RPC call, with one retry when PostgREST cannot see the function yet.
 *
 * Applying a migration ends by asking for a schema reload, so the cache
 * refreshes on its own within a moment; the retry covers requests that land
 * inside that window rather than failing work the database can perfectly well
 * do.
 *
 * @returns {Promise<{response: Response, result: any}>}
 */
export async function callRpc(url, key, name, args) {
  let response = await post(url, key, name, args);
  let result = await response.json();
  if (!response.ok && STALE_CACHE.has(result?.code)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    response = await post(url, key, name, args);
    result = await response.json();
  }
  return { response, result };
}

/**
 * A failed RPC as an HTTP answer.
 *
 *   PGRST202/204  503  the function is not on this project — name the migration
 *   P0002         404  it asked about something that does not exist
 *   P0001         409  the engine refused it; pass its own sentence through
 *   anything else 502  the database could not answer
 *
 * @param {any} result the PostgREST error body
 * @param {string} migration the file to apply, for the 503
 * @param {string} fallback the message when Postgres sent none
 */
export function rpcError(result, migration, fallback) {
  if (STALE_CACHE.has(result?.code)) {
    console.error('fsnv2 API: an RPC is missing — apply %s.', migration);
    return { status: 503, body: { error: `This feature is not set up yet. Apply ${migration}.` } };
  }
  if (result?.code === NOT_FOUND) {
    return { status: 404, body: { error: result.message || fallback } };
  }
  if (result?.code === REFUSED) {
    return { status: 409, body: { error: result.message || fallback } };
  }
  return { status: 502, body: { error: result?.message || fallback } };
}

/**
 * Cron invocations carry the shared secret as a bearer token, the way
 * /api/sync's does (lib/api/syncRoute.ts). A missing CRON_SECRET is reported
 * rather than treated as authorisation to lock everyone out: the route is only
 * reachable through the project's deployment protection until one is set.
 *
 * @param {{headers?: Record<string, any>, query?: Record<string, any>}} req
 * @returns {{ok: boolean, warning?: string}}
 */
export function authorizeCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return {
      ok: true,
      warning:
        'CRON_SECRET is not set — this route is protected only by the project’s deployment protection. Add CRON_SECRET in the Vercel project settings.'
    };
  }
  const header = String(req?.headers?.authorization ?? req?.headers?.Authorization ?? '');
  const presented = header.startsWith('Bearer ')
    ? header.slice(7)
    : String(req?.query?.secret ?? '');
  return { ok: presented === secret };
}

/** POST body or query string, whichever this request carried. */
export function params(req) {
  return (req?.method === 'POST' ? req.body : req?.query) || {};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function isTeamId(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 1;
}

/**
 * An ISO instant the caller pinned the run to, or null. Every engine RPC takes
 * `p_now` for the same reason `isPlayerLocked()` takes a clock: a scheduled run
 * and a test have to be able to stand at a chosen moment, and the lock checks
 * inside the transaction have to read the same one.
 */
export function instant(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  return send(res, 405, { error: 'Method not allowed.' });
}
