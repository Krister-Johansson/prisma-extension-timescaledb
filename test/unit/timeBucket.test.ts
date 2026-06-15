import { describe, expect, it } from "vitest";
import { buildTimeBucketQuery, type TimeBucketRuntimeArgs } from "../../src/client/timeBucket.js";

const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") };
const base: TimeBucketRuntimeArgs = {
  bucket: "1 hour",
  range,
  aggregate: { avgTemp: { avg: "temperature" }, n: { count: "temperature" } },
};

describe("buildTimeBucketQuery", () => {
  it("builds a parameterized query with quoted identifiers, count::int, and no relation cast", () => {
    const { sql, params } = buildTimeBucketQuery("SensorReading", "time", { ...base, groupBy: ["deviceId"] });
    expect(sql).toContain(`time_bucket($1, "time") AS "bucket"`);
    expect(sql).toContain(`avg("temperature") AS "avgTemp"`);
    expect(sql).toContain(`count("temperature")::int AS "n"`);
    expect(sql).toContain(`FROM "SensorReading"`);
    expect(sql).toContain(`GROUP BY "bucket", "deviceId"`);
    expect(sql).not.toContain("::regclass");
    expect(params).toEqual(["1 hour", range.start, range.end]);
  });

  it("appends equality filters as bound params", () => {
    const { sql, params } = buildTimeBucketQuery("SensorReading", "time", { ...base, where: { deviceId: 1 } });
    expect(sql).toContain(`AND "deviceId" = $4`);
    expect(params).toEqual(["1 hour", range.start, range.end, 1]);
  });

  it("skips undefined where values instead of binding them as NULL", () => {
    const { sql, params } = buildTimeBucketQuery("SensorReading", "time", { ...base, where: { deviceId: undefined } });
    expect(sql).not.toContain("deviceId");
    expect(params).toEqual(["1 hour", range.start, range.end]);
  });

  it("throws on non-primitive where values (operators not supported in v0.1)", () => {
    expect(() => buildTimeBucketQuery("SensorReading", "time", { ...base, where: { deviceId: { gte: 1 } } })).toThrow(
      /equality only/,
    );
  });

  it("resolves @map columns to DB names while aliasing results to Prisma field names", () => {
    const { sql, params } = buildTimeBucketQuery(
      "sensor_readings",
      "ts",
      { ...base, groupBy: ["deviceId"], where: { deviceId: 1 } },
      { deviceId: "device_id", time: "ts" },
    );
    expect(sql).toContain(`FROM "sensor_readings"`);
    expect(sql).toContain(`time_bucket($1, "ts") AS "bucket"`);
    expect(sql).toContain(`"device_id" AS "deviceId"`); // DB column selected, Prisma name aliased
    expect(sql).toContain(`avg("temperature") AS "avgTemp"`); // unmapped column = identity
    expect(sql).toContain(`AND "device_id" = $4`); // where key resolved to DB column
    expect(sql).toContain(`GROUP BY "bucket", "deviceId"`); // group by the output alias
    expect(params).toEqual(["1 hour", range.start, range.end, 1]);
  });

  it("throws when range bounds are missing", () => {
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { bucket: "1 hour", aggregate: base.aggregate } as TimeBucketRuntimeArgs),
    ).toThrow(/range\.start.+range\.end.+required/);
  });
});
