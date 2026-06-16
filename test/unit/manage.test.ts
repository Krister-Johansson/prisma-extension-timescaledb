import { describe, expect, it } from "vitest";
import { makeManage, type RawClient } from "../../src/client/manage.js";

function fakeClient() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client: RawClient = {
    async $executeRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return 0;
    },
  };
  return { client, calls };
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
