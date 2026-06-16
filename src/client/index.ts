// Runtime client extension entry (SPEC §4 / BUILD_PLAN M4).
//
// Resilience requirement (CLAUDE.md): timescaledb() accepts a manual config object so it
// works WITHOUT the generator. The generator's emitted `registry` is assignable to this
// config shape, so `timescaledb(registry)` is just the generated path.
import { Prisma } from "@prisma/client/extension";
import type { CaggConfig, HypertableConfig, RelationConfig } from "../core/types.js";
import { assertInterval } from "../core/interval.js";
import {
  buildTimeBucketQuery,
  type TimeBucketMethod,
  type TimeBucketRuntimeArgs,
} from "./timeBucket.js";
import { makeManage, type RawClient } from "./manage.js";

/** Manual configuration accepted by `timescaledb()` (also satisfied by the generated registry). */
export interface TimescaleConfig {
  hypertables?: readonly HypertableConfig[];
  // Accepted so the generated `registry` is assignable as-is. Not needed at runtime today
  // (cagg reads go through the Prisma `view`; refresh takes the name) — reserved for future
  // use (e.g. typed cagg helpers) without a breaking config change.
  continuousAggregates?: readonly CaggConfig[];
  /**
   * Relations of related (non-hypertable) models, keyed by Prisma model name. Emitted by the
   * generator so a `timeBucket` where can nest relation filters THROUGH other relations to any
   * depth. Absent => relation filters work one level deep only (the pre-generator-bump behavior).
   */
  relationsByModel?: Record<string, readonly RelationConfig[]>;
}

/**
 * @internal Union of registered hypertable model names from a config (`model ?? table`), used to
 * type the `$timescale` retention helpers so a typo is a compile error. `never` when none.
 */
export type HypertableModelNames<C> = C extends { hypertables: readonly (infer H)[] }
  ? H extends { model: infer M extends string }
    ? M
    : H extends { table: infer T extends string }
      ? T
      : never
  : never;

/** @internal Union of registered continuous-aggregate model names (`model ?? name`), for refresh. */
export type CaggModelNames<C> = C extends { continuousAggregates: readonly (infer X)[] }
  ? X extends { model: infer M extends string }
    ? M
    : X extends { name: infer N extends string }
      ? N
      : never
  : never;

/** @internal `never` (nothing registered / non-literal names) widens back to `string` so the helper stays callable. */
export type NamesOrString<T> = [T] extends [never] ? string : T;

interface UnsafeRawClient extends RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * Build the TimescaleDB Prisma client extension.
 *
 * @example
 * const prisma = new PrismaClient().$extends(timescaledb(registry));
 */
export function timescaledb<const C extends TimescaleConfig = TimescaleConfig>(config: C = {} as C) {
  // Key by Prisma model name (ctx.$name); values hold the resolved DB table + schema + column map.
  const hypertableByModel = new Map<
    string,
    { table: string; schema?: string; column: string; columns: Record<string, string> }
  >();
  // Prisma model name -> that model's relations, for relation filters in timeBucket where. The
  // generator's `relationsByModel` covers related (non-hypertable) models; each hypertable's own
  // relations come from its config entry. Together they let filters nest through relations to any depth.
  const relationsByModel = new Map<string, readonly RelationConfig[]>();
  for (const [name, rels] of Object.entries(config.relationsByModel ?? {})) {
    relationsByModel.set(name, rels);
  }
  for (const h of config.hypertables ?? []) {
    const name = h.model ?? h.table;
    hypertableByModel.set(name, {
      table: h.table,
      // !== undefined (not truthy): keep an explicitly-set schema so an invalid value like ""
      // reaches identifier validation instead of being silently dropped to an unqualified target.
      ...(h.schema !== undefined ? { schema: h.schema } : {}),
      column: h.column,
      columns: { ...(h.columns ?? {}) },
    });
    if (h.relations && h.relations.length > 0 && !relationsByModel.has(name)) {
      relationsByModel.set(name, h.relations);
    }
  }
  // Prisma view model name -> DB view name + schema, for refreshContinuousAggregate.
  const caggViewByModel = new Map<string, { name: string; schema?: string }>();
  for (const c of config.continuousAggregates ?? []) {
    caggViewByModel.set(c.model ?? c.name, { name: c.name, ...(c.schema !== undefined ? { schema: c.schema } : {}) });
  }

  /**
   * The `model.timeBucket(...)` method: resolve the model to its hypertable config, build the
   * parameterized query (incl. where / relation filters), and run it via `$queryRawUnsafe`.
   */
  const timeBucket = async function (this: unknown, args: TimeBucketRuntimeArgs) {
    const ctx = Prisma.getExtensionContext(this);
    const model = ctx.$name;
    if (typeof model !== "string") {
      throw new Error("timeBucket: could not resolve the model name from the extension context.");
    }
    const ht = hypertableByModel.get(model);
    if (!ht) {
      throw new Error(
        `timeBucket: "${model}" is not a registered hypertable. Pass it via timescaledb({ hypertables: [...] }) or run the generator.`,
      );
    }
    assertInterval(args.bucket);
    const { sql, params } = buildTimeBucketQuery(ht.table, ht.column, args, ht.columns, ht.schema, relationsByModel, model);
    return (ctx.$parent as UnsafeRawClient).$queryRawUnsafe(sql, ...params);
  } as unknown as TimeBucketMethod;

  return Prisma.defineExtension((client) =>
    client.$extends({
      name: "prisma-extension-timescaledb",
      model: {
        $allModels: { timeBucket },
      },
      client: {
        $timescale: makeManage<NamesOrString<HypertableModelNames<C>>, NamesOrString<CaggModelNames<C>>>(
          client as unknown as RawClient,
          caggViewByModel,
          { hypertableByModel },
        ),
      },
    }),
  );
}

export type { TimeBucketArgs, TimeBucketRow, AggregateInput } from "./timeBucket.js";
export type { TimescaleManage, RefreshRange } from "./manage.js";
