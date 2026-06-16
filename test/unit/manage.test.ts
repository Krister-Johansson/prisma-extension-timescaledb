import { describe, expect, it } from "vitest";
import { makeManage, type RawClient } from "../../src/client/manage.js";

function fakeClient(queryRows: unknown[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  const client: RawClient = {
    async $executeRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return 0;
    },
    async $queryRawUnsafe(sql: string, ...params: unknown[]) {
      queries.push({ sql, params });
      return queryRows as never;
    },
  };
  return { client, calls, queries };
}

/** A client whose $executeRawUnsafe throws `failWith` for the first `failTimes` calls. */
function flakyClient(failWith: unknown, failTimes: number) {
  let attempts = 0;
  const client: RawClient = {
    async $executeRawUnsafe() {
      attempts++;
      if (attempts <= failTimes) throw failWith;
      return 0;
    },
    async $queryRawUnsafe() {
      return [] as never;
    },
  };
  return { client, attempts: () => attempts };
}

// SQLSTATE 55P03 surfaced via the driver's `meta.code` only (message carries no code).
const metaConcurrent = Object.assign(new Error("lock not available"), { meta: { code: "55P03" } });
// SQLSTATE 55P03 surfaced only inside Prisma's rendered raw-query message (no `meta`).
const messageConcurrent = new Error(
  "Invalid `prisma.$executeRawUnsafe()` invocation:\n" +
    "Raw query failed. Code: `55P03`. Message: `could not refresh continuous aggregate due to a concurrent refresh`",
);
const otherError = Object.assign(new Error("Raw query failed. Code: `42P01`. relation does not exist"), {
  meta: { code: "42P01" },
});
const noSleep = async () => {};

describe("makeManage.refreshContinuousAggregate", () => {
  it("full refresh uses literal NULL bounds and binds no params", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).refreshContinuousAggregate("SensorHourly");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(`CALL refresh_continuous_aggregate('"SensorHourly"', NULL, NULL)`);
    expect(calls[0]!.params).toEqual([]);
  });

  it("windowed refresh binds provided dates as params", async () => {
    const { client, calls } = fakeClient();
    const start = new Date("2026-06-15T00:00:00Z");
    const end = new Date("2026-06-16T00:00:00Z");
    await makeManage(client).refreshContinuousAggregate("SensorHourly", { start, end });
    expect(calls[0]!.sql).toBe(`CALL refresh_continuous_aggregate('"SensorHourly"', $1, $2)`);
    expect(calls[0]!.params).toEqual([start, end]);
  });

  it("mixes a literal NULL with a bound param when only one bound is given", async () => {
    const { client, calls } = fakeClient();
    const start = new Date("2026-06-15T00:00:00Z");
    await makeManage(client).refreshContinuousAggregate("SensorHourly", { start });
    expect(calls[0]!.sql).toBe(`CALL refresh_continuous_aggregate('"SensorHourly"', $1, NULL)`);
    expect(calls[0]!.params).toEqual([start]);
  });

  it("rejects an unsafe continuous-aggregate name", async () => {
    const { client } = fakeClient();
    await expect(makeManage(client).refreshContinuousAggregate("bad name")).rejects.toThrow(/Invalid/);
  });

  it("resolves the Prisma view model name to its @@map DB view name", async () => {
    const { client, calls } = fakeClient();
    const viewByModel = new Map([["SensorHourly", { name: "sensor_hourly" }]]);
    await makeManage(client, viewByModel).refreshContinuousAggregate("SensorHourly");
    expect(calls[0]!.sql).toBe(`CALL refresh_continuous_aggregate('"sensor_hourly"', NULL, NULL)`);
  });

  it("schema-qualifies the cagg name when a @@schema is configured", async () => {
    const { client, calls } = fakeClient();
    const viewByModel = new Map([["SensorHourly", { name: "sensor_hourly", schema: "metrics" }]]);
    await makeManage(client, viewByModel).refreshContinuousAggregate("SensorHourly");
    expect(calls[0]!.sql).toBe(`CALL refresh_continuous_aggregate('"metrics"."sensor_hourly"', NULL, NULL)`);
  });

  it("retries a concurrent-policy refresh (55P03 in the message) then succeeds", async () => {
    const { client, attempts } = flakyClient(messageConcurrent, 2);
    await makeManage(client, new Map(), { sleep: noSleep }).refreshContinuousAggregate("SensorHourly");
    expect(attempts()).toBe(3); // two 55P03s, then success
  });

  it("detects a concurrent refresh via the driver's meta.code", async () => {
    const { client, attempts } = flakyClient(metaConcurrent, 1);
    await makeManage(client, new Map(), { sleep: noSleep }).refreshContinuousAggregate("SensorHourly");
    expect(attempts()).toBe(2);
  });

  it("gives up after maxRefreshAttempts and rethrows the 55P03 error", async () => {
    const { client, attempts } = flakyClient(messageConcurrent, Number.POSITIVE_INFINITY);
    await expect(
      makeManage(client, new Map(), { sleep: noSleep, maxRefreshAttempts: 3 }).refreshContinuousAggregate("SensorHourly"),
    ).rejects.toBe(messageConcurrent);
    expect(attempts()).toBe(3);
  });

  it("does not retry errors other than 55P03", async () => {
    const { client, attempts } = flakyClient(otherError, Number.POSITIVE_INFINITY);
    await expect(
      makeManage(client, new Map(), { sleep: noSleep }).refreshContinuousAggregate("SensorHourly"),
    ).rejects.toBe(otherError);
    expect(attempts()).toBe(1); // failed fast, no retry
  });

  it("treats a non-finite or sub-1 maxRefreshAttempts as a safe default (never a silent no-op)", async () => {
    // NaN/Infinity/0/negative must not skip the loop entirely — the refresh must still run.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -3]) {
      const { client, calls } = fakeClient();
      await makeManage(client, new Map(), { maxRefreshAttempts: bad, sleep: noSleep }).refreshContinuousAggregate(
        "SensorHourly",
      );
      expect(calls).toHaveLength(1); // executed exactly once
    }
  });
});

describe("makeManage retention policies", () => {
  it("addRetentionPolicy emits add_retention_policy with the quoted relation literal", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).addRetentionPolicy("SensorReading", { dropAfter: "30 days" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(
      `SELECT add_retention_policy('"SensorReading"', drop_after => INTERVAL '30 days', if_not_exists => TRUE)`,
    );
    expect(calls[0]!.params).toEqual([]);
  });

  it("resolves the model to its @@map / @@schema relation", async () => {
    const { client, calls } = fakeClient();
    const hypertableByModel = new Map([["SensorReading", { table: "sensor_readings", schema: "metrics" }]]);
    await makeManage(client, new Map(), { hypertableByModel }).addRetentionPolicy("SensorReading", {
      dropAfter: "7 days",
    });
    expect(calls[0]!.sql).toBe(
      `SELECT add_retention_policy('"metrics"."sensor_readings"', drop_after => INTERVAL '7 days', if_not_exists => TRUE)`,
    );
  });

  it("removeRetentionPolicy emits an idempotent remove", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).removeRetentionPolicy("SensorReading");
    expect(calls[0]!.sql).toBe(`SELECT remove_retention_policy('"SensorReading"', if_exists => TRUE)`);
  });

  it("rejects an invalid dropAfter interval", async () => {
    const { client } = fakeClient();
    await expect(
      makeManage(client).addRetentionPolicy("SensorReading", { dropAfter: "1 fortnight" as never }),
    ).rejects.toThrow(/Invalid interval/);
  });

  it("rejects an unsafe model/relation name", async () => {
    const { client } = fakeClient();
    await expect(makeManage(client).addRetentionPolicy("bad name", { dropAfter: "1 day" })).rejects.toThrow(/Invalid/);
  });
});

describe("makeManage compression policies", () => {
  it("addCompressionPolicy enables the columnstore then adds the policy (two statements)", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).addCompressionPolicy("SensorReading", {
      after: "7 days",
      segmentBy: "deviceId",
      orderBy: "time DESC",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toBe(
      `ALTER TABLE "SensorReading" SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = '"deviceId"', timescaledb.orderby = '"time" DESC')`,
    );
    expect(calls[1]!.sql).toBe(
      `CALL add_columnstore_policy('"SensorReading"', after => INTERVAL '7 days', if_not_exists => TRUE)`,
    );
  });

  it("accepts array segmentBy + structured orderBy and maps Prisma field names via @map / @@schema", async () => {
    const { client, calls } = fakeClient();
    const hypertableByModel = new Map([
      ["SensorReading", { table: "sensor_readings", schema: "metrics", columns: { deviceId: "device_id", time: "ts" } }],
    ]);
    await makeManage(client, new Map(), { hypertableByModel }).addCompressionPolicy("SensorReading", {
      after: "7 days",
      segmentBy: ["deviceId"],
      orderBy: [{ column: "time", direction: "desc", nulls: "last" }],
    });
    expect(calls[0]!.sql).toBe(
      `ALTER TABLE "metrics"."sensor_readings" SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = '"device_id"', timescaledb.orderby = '"ts" DESC NULLS LAST')`,
    );
    expect(calls[1]!.sql).toBe(
      `CALL add_columnstore_policy('"metrics"."sensor_readings"', after => INTERVAL '7 days', if_not_exists => TRUE)`,
    );
  });

  it("omits segmentby / orderby when not provided (enable columnstore only)", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).addCompressionPolicy("SensorReading", { after: "30 days" });
    expect(calls[0]!.sql).toBe(`ALTER TABLE "SensorReading" SET (timescaledb.enable_columnstore = true)`);
  });

  it("removeCompressionPolicy emits an idempotent CALL remove", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).removeCompressionPolicy("SensorReading");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(`CALL remove_columnstore_policy('"SensorReading"', if_exists => TRUE)`);
  });

  it("rejects an invalid after interval", async () => {
    const { client } = fakeClient();
    await expect(
      makeManage(client).addCompressionPolicy("SensorReading", { after: "1 fortnight" as never }),
    ).rejects.toThrow(/Invalid interval/);
  });

  it("rejects an unsafe model/relation name", async () => {
    const { client } = fakeClient();
    await expect(makeManage(client).addCompressionPolicy("bad name", { after: "1 day" })).rejects.toThrow(/Invalid/);
  });
});

describe("makeManage chunk + size helpers", () => {
  const hypertableByModel = new Map([["SensorReading", { table: "sensor_readings", schema: "metrics" }]]);

  it("dropChunks with an interval bound interpolates a validated INTERVAL literal and maps the @@schema relation", async () => {
    const { client, queries } = fakeClient([{ chunk: "_hyper_1_1_chunk" }, { chunk: "_hyper_1_2_chunk" }]);
    const dropped = await makeManage(client, new Map(), { hypertableByModel }).dropChunks("SensorReading", {
      olderThan: "30 days",
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toBe(
      `SELECT drop_chunks('"metrics"."sensor_readings"', older_than => INTERVAL '30 days') AS chunk`,
    );
    expect(queries[0]!.params).toEqual([]);
    expect(dropped).toEqual(["_hyper_1_1_chunk", "_hyper_1_2_chunk"]);
  });

  it("dropChunks supports an older/newer interval window (typed INTERVAL literals, no bind params)", async () => {
    const { client, queries } = fakeClient([]);
    await makeManage(client).dropChunks("SensorReading", { olderThan: "7 days", newerThan: "30 days" });
    expect(queries[0]!.sql).toBe(
      `SELECT drop_chunks('"SensorReading"', older_than => INTERVAL '7 days', newer_than => INTERVAL '30 days') AS chunk`,
    );
    expect(queries[0]!.params).toEqual([]);
  });

  it("dropChunks requires at least one bound and rejects an invalid interval", async () => {
    await expect(makeManage(fakeClient().client).dropChunks("SensorReading", {})).rejects.toThrow(
      /olderThan and\/or newerThan/,
    );
    await expect(
      makeManage(fakeClient().client).dropChunks("SensorReading", { olderThan: "1 fortnight" as never }),
    ).rejects.toThrow(/Invalid interval/);
  });

  it("hypertableSize / approximateRowCount return the scalar bigint", async () => {
    const size = fakeClient([{ bytes: 253952n }]);
    expect(await makeManage(size.client).hypertableSize("SensorReading")).toBe(253952n);
    expect(size.queries[0]!.sql).toBe(`SELECT hypertable_size('"SensorReading"') AS bytes`);

    const count = fakeClient([{ count: 1000n }]);
    expect(await makeManage(count.client).approximateRowCount("SensorReading")).toBe(1000n);
    expect(count.queries[0]!.sql).toBe(`SELECT approximate_row_count('"SensorReading"') AS count`);
  });

  it("hypertableDetailedSize maps the columns to camelCase bigints", async () => {
    const { client, queries } = fakeClient([{ table_bytes: 1n, index_bytes: 2n, toast_bytes: 3n, total_bytes: 6n }]);
    expect(await makeManage(client).hypertableDetailedSize("SensorReading")).toEqual({
      tableBytes: 1n,
      indexBytes: 2n,
      toastBytes: 3n,
      totalBytes: 6n,
    });
    expect(queries[0]!.sql).toContain(`FROM hypertable_detailed_size('"SensorReading"')`);
  });

  it("compressionStats maps chunk counts + before/after bytes (null when uncompressed)", async () => {
    const { client } = fakeClient([
      { total_chunks: 5n, number_compressed_chunks: 0n, before_compression_total_bytes: null, after_compression_total_bytes: null },
    ]);
    expect(await makeManage(client).compressionStats("SensorReading")).toEqual({
      totalChunks: 5n,
      compressedChunks: 0n,
      beforeTotalBytes: null,
      afterTotalBytes: null,
    });
  });

  it("rejects an unsafe model/relation name", async () => {
    await expect(makeManage(fakeClient().client).hypertableSize("bad name")).rejects.toThrow(/Invalid/);
  });
});

describe("makeManage continuous-aggregate policies", () => {
  const policy = { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" } as const;

  it("addContinuousAggregatePolicy emits add_continuous_aggregate_policy with interval offsets", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).addContinuousAggregatePolicy("SensorHourly", policy);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(
      `SELECT add_continuous_aggregate_policy('"SensorHourly"', start_offset => INTERVAL '1 month', end_offset => INTERVAL '1 hour', schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)`,
    );
  });

  it("resolves the cagg model to its @@map / @@schema view name", async () => {
    const { client, calls } = fakeClient();
    const viewByModel = new Map([["SensorHourly", { name: "sensor_hourly", schema: "metrics" }]]);
    await makeManage(client, viewByModel).addContinuousAggregatePolicy("SensorHourly", policy);
    expect(calls[0]!.sql).toContain(`add_continuous_aggregate_policy('"metrics"."sensor_hourly"'`);
  });

  it("removeContinuousAggregatePolicy emits an idempotent remove", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).removeContinuousAggregatePolicy("SensorHourly");
    expect(calls[0]!.sql).toBe(`SELECT remove_continuous_aggregate_policy('"SensorHourly"', if_not_exists => TRUE)`);
  });

  it("rejects an invalid offset interval and an unsafe cagg name", async () => {
    await expect(
      makeManage(fakeClient().client).addContinuousAggregatePolicy("SensorHourly", {
        ...policy,
        startOffset: "1 fortnight" as never,
      }),
    ).rejects.toThrow(/Invalid interval/);
    await expect(makeManage(fakeClient().client).removeContinuousAggregatePolicy("bad name")).rejects.toThrow(/Invalid/);
  });
});

describe("makeManage chunk skipping", () => {
  it("enableChunkSkipping emits one DO block that sets the GUC then enables (pool-safe, idempotent)", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).enableChunkSkipping("SensorReading", "eventId");
    expect(calls).toHaveLength(1);
    // One statement / one connection: SET LOCAL + enable_chunk_skipping in a single DO block, so the
    // session GUC is reliably on for the call even under Prisma's connection pool.
    expect(calls[0]!.sql).toBe(
      `DO $$ BEGIN SET LOCAL timescaledb.enable_chunk_skipping = on; PERFORM enable_chunk_skipping('"SensorReading"', 'eventId', if_not_exists => TRUE); END $$`,
    );
    expect(calls[0]!.params).toEqual([]);
  });

  it("disableChunkSkipping emits an idempotent disable in the same DO-block form", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).disableChunkSkipping("SensorReading", "eventId");
    expect(calls[0]!.sql).toBe(
      `DO $$ BEGIN SET LOCAL timescaledb.enable_chunk_skipping = on; PERFORM disable_chunk_skipping('"SensorReading"', 'eventId', if_not_exists => TRUE); END $$`,
    );
  });

  it("maps the Prisma field name to its DB column and schema-qualifies the relation (@map / @@schema)", async () => {
    const { client, calls } = fakeClient();
    const hypertableByModel = new Map([
      ["SensorReading", { table: "sensor_readings", schema: "metrics", columns: { eventId: "event_id" } }],
    ]);
    await makeManage(client, new Map(), { hypertableByModel }).enableChunkSkipping("SensorReading", "eventId");
    expect(calls[0]!.sql).toBe(
      `DO $$ BEGIN SET LOCAL timescaledb.enable_chunk_skipping = on; PERFORM enable_chunk_skipping('"metrics"."sensor_readings"', 'event_id', if_not_exists => TRUE); END $$`,
    );
  });

  it("rejects an unsafe model/relation name and an unsafe column name", async () => {
    await expect(makeManage(fakeClient().client).enableChunkSkipping("bad name", "eventId")).rejects.toThrow(/Invalid/);
    await expect(makeManage(fakeClient().client).disableChunkSkipping("SensorReading", "bad col")).rejects.toThrow(
      /Invalid/,
    );
  });
});
