// Where TimescaleDB's functions live, from the runtime's point of view.
//
// The emitted queries name `time_bucket`, `show_chunks`, `stats_agg` and friends without a
// schema, which resolves them through the connection's `search_path`. That is fine on a default
// connection, where `public` is on the path and both extensions install into it. It stops being
// fine the moment someone narrows the path, and `ALTER ROLE app SET search_path TO data_collection`
// is ordinary practice in a database shared by several services:
//
//   ERROR: function time_bucket(unknown, timestamp with time zone) does not exist
//
// Prisma's own queries survive that, because the engine schema-qualifies the relations it
// generates. Raw SQL does not, so this module resolves each extension's schema once per client
// and hands back a prefix to put in front of its function names.
import type { RawClient } from "./manage.js";

/**
 * Schema prefixes for TimescaleDB function calls, ready to concatenate: either `"public."` (or
 * whatever schema the extension lives in, quoted) or `""` when the functions already resolve on
 * this connection's search path.
 *
 * `ts` is core TimescaleDB (`time_bucket`, `show_chunks`, the policy functions); `tk` is
 * `timescaledb_toolkit` (`stats_agg`, `candlestick_agg`, `approx_percentile` and the accessors
 * that read them). They are separate extensions and can live in separate schemas.
 */
export interface FnPrefix {
  ts: string;
  tk: string;
}

/** Qualify nothing: what a default connection needs, and the fallback when the probe fails. */
export const NO_PREFIX: FnPrefix = { ts: "", tk: "" };

/**
 * One round trip that answers both halves of the question for both extensions: where it is
 * installed, and whether its functions are already reachable without saying so.
 *
 * `to_regprocedure` resolves an unqualified name through the current search path and returns
 * NULL rather than raising when nothing matches, which is exactly the visibility test. The
 * signatures are ones that exist in every version this package supports.
 */
const PROBE = `SELECT
  (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'timescaledb') AS ts_schema,
  (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'timescaledb_toolkit') AS tk_schema,
  to_regprocedure('time_bucket(interval, timestamp with time zone)') IS NOT NULL AS ts_visible,
  to_regprocedure('stats_agg(double precision)') IS NOT NULL AS tk_visible`;

interface ProbeRow {
  ts_schema: string | null;
  tk_schema: string | null;
  ts_visible: boolean;
  tk_visible: boolean;
}

/** Quote a schema name and append the dot, so it can be concatenated onto a function name. */
function prefixOf(schema: string | null, visible: boolean): string {
  if (visible || schema === null) return "";
  return `"${schema.replace(/"/g, '""')}".`;
}

/**
 * Ask the database where the extensions are and whether their functions already resolve.
 * `undefined` means the question could not be answered, which callers turn into `NO_PREFIX`:
 * qualification is an improvement on the unqualified form, not a precondition for it, so a
 * failed probe must not take the whole call down with it.
 *
 * Never throws. The distinction between "answered, nothing to qualify" and "could not answer"
 * matters to the caching in `memoizeFnPrefix`, hence `undefined` rather than `NO_PREFIX` here.
 */
export async function probeFnPrefix(client: RawClient): Promise<FnPrefix | undefined> {
  try {
    const rows = await client.$queryRawUnsafe<ProbeRow[]>(PROBE);
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row) return undefined;
    return { ts: prefixOf(row.ts_schema, row.ts_visible), tk: prefixOf(row.tk_schema, row.tk_visible) };
  } catch {
    return undefined;
  }
}

/**
 * Memoize the probe for the life of a client. One extra round trip on the first `timeBucket` or
 * `$timescale` call, nothing after that.
 *
 * The answer is cached against the client the extension was applied to, so transaction clients
 * derived from it reuse it rather than probing per transaction. That assumes the search path does
 * not change between connections of one pool, which is what a role default or a connection option
 * gives you. A session that runs its own `SET search_path` mid-flight can outrun the cache; the
 * failure mode there is the unqualified SQL this package sent before, not something new.
 *
 * Only a real answer is cached. A probe that could not reach the database falls back to
 * `NO_PREFIX` for that call alone: caching it would leave a client emitting unqualified SQL for
 * the rest of its life because of one connection blip, which on a narrowed search path means
 * every later query fails.
 */
export function memoizeFnPrefix(client: RawClient): () => Promise<FnPrefix> {
  let cached: FnPrefix | undefined;
  let pending: Promise<FnPrefix | undefined> | undefined;
  return async () => {
    if (cached) return cached;
    // Concurrent callers share one probe; whoever resolves first clears the slot, and the
    // others already hold the promise.
    pending ??= probeFnPrefix(client);
    const answer = await pending;
    pending = undefined;
    if (answer) cached = answer;
    return answer ?? NO_PREFIX;
  };
}
