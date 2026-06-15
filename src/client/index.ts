// Runtime client extension entry (SPEC §4 / BUILD_PLAN M4).
//
// Resilience requirement (CLAUDE.md): timescaledb() accepts a manual config object so it
// works WITHOUT the generator. The generator's emitted `registry` is assignable to this
// config shape, so `timescaledb(registry)` is just the generated path.
import { Prisma } from "@prisma/client/extension";
import type { CaggConfig, HypertableConfig } from "../core/types.js";
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
}

interface UnsafeRawClient extends RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * Build the TimescaleDB Prisma client extension.
 *
 * @example
 * const prisma = new PrismaClient().$extends(timescaledb(registry));
 */
export function timescaledb(config: TimescaleConfig = {}) {
  // Key by Prisma model name (ctx.$name); values hold the resolved DB table + column map.
  const hypertableByModel = new Map<string, { table: string; column: string; columns: Record<string, string> }>();
  for (const h of config.hypertables ?? []) {
    hypertableByModel.set(h.model ?? h.table, { table: h.table, column: h.column, columns: { ...(h.columns ?? {}) } });
  }
  // Prisma view model name -> DB view name, for refreshContinuousAggregate.
  const caggViewByModel = new Map<string, string>();
  for (const c of config.continuousAggregates ?? []) {
    caggViewByModel.set(c.model ?? c.name, c.name);
  }

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
    const { sql, params } = buildTimeBucketQuery(ht.table, ht.column, args, ht.columns);
    return (ctx.$parent as UnsafeRawClient).$queryRawUnsafe(sql, ...params);
  } as unknown as TimeBucketMethod;

  return Prisma.defineExtension((client) =>
    client.$extends({
      name: "prisma-extension-timescaledb",
      model: {
        $allModels: { timeBucket },
      },
      client: {
        $timescale: makeManage(client as unknown as RawClient, caggViewByModel),
      },
    }),
  );
}

export type { TimeBucketArgs, TimeBucketRow, AggregateInput } from "./timeBucket.js";
export type { TimescaleManage, RefreshRange } from "./manage.js";
