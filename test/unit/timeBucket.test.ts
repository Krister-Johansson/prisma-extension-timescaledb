import { describe, expect, it } from "vitest";
import { buildTimeBucketQuery, type TimeBucketRuntimeArgs } from "../../src/client/timeBucket.js";
import type { RelationConfig } from "../../src/core/types.js";

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
    expect(sql).toContain(`avg("temperature")::double precision AS "avgTemp"`);
    expect(sql).toContain(`count("temperature")::int AS "n"`);
    expect(sql).toContain(`FROM "SensorReading"`);
    expect(sql).toContain(`GROUP BY "bucket", "deviceId"`);
    expect(sql).not.toContain("::regclass");
    expect(params).toEqual(["1 hour", range.start, range.end]);
  });

  it("casts sum/avg to double precision (integer-column aggregates return JS numbers)", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: { total: { sum: "deviceId" }, mean: { avg: "deviceId" }, hi: { max: "deviceId" } },
    });
    expect(sql).toContain(`sum("deviceId")::double precision AS "total"`);
    expect(sql).toContain(`avg("deviceId")::double precision AS "mean"`);
    expect(sql).toContain(`max("deviceId") AS "hi"`); // min/max keep the column type
  });

  it("emits exact casts per the `as` selector (bigint -> ::bigint, string -> ::text)", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: {
        total: { sum: "deviceId", as: "bigint" },
        rows: { count: "deviceId", as: "bigint" },
        avgStr: { avg: "deviceId", as: "string" },
        sumStr: { sum: "deviceId", as: "string" },
        plain: { sum: "deviceId" }, // default -> double precision
      },
    });
    expect(sql).toContain(`sum("deviceId")::bigint AS "total"`);
    expect(sql).toContain(`count("deviceId")::bigint AS "rows"`); // no ::int overflow past 2^31 rows
    expect(sql).toContain(`avg("deviceId")::text AS "avgStr"`);
    expect(sql).toContain(`sum("deviceId")::text AS "sumStr"`);
    expect(sql).toContain(`sum("deviceId")::double precision AS "plain"`);
  });

  it("resolves @map columns under an `as` cast", () => {
    const { sql } = buildTimeBucketQuery(
      "sensor_readings",
      "ts",
      { ...base, aggregate: { total: { sum: "deviceId", as: "bigint" } } },
      { deviceId: "device_id", time: "ts" },
    );
    expect(sql).toContain(`sum("device_id")::bigint AS "total"`);
  });

  it("rejects fn + as combinations the types forbid (defensive, for non-TS callers)", () => {
    const make = (agg: Record<string, Record<string, string>>) => () =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, aggregate: agg });
    expect(make({ x: { avg: "deviceId", as: "bigint" } })).toThrow(/not valid for "avg"/); // avg is fractional
    expect(make({ x: { count: "deviceId", as: "string" } })).toThrow(/not valid for "count"/); // count is an integer
    expect(make({ x: { min: "deviceId", as: "bigint" } })).toThrow(/not valid for "min"/); // min/max have no `as`
    expect(make({ x: { sum: "deviceId", as: "float" } })).toThrow(/not valid for "sum"/); // unknown `as` value
  });

  it("appends equality filters as bound params", () => {
    const { sql, params } = buildTimeBucketQuery("SensorReading", "time", { ...base, where: { deviceId: 1 } });
    expect(sql).toContain(`AND ("deviceId" = $4)`);
    expect(params).toEqual(["1 hour", range.start, range.end, 1]);
  });

  it("skips undefined where values instead of binding them as NULL", () => {
    const { sql, params } = buildTimeBucketQuery("SensorReading", "time", { ...base, where: { deviceId: undefined } });
    expect(sql).not.toContain("deviceId");
    expect(params).toEqual(["1 hour", range.start, range.end]);
  });

  it("supports comparison operators in where (parameterized)", () => {
    const { sql, params } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      where: { deviceId: { in: [1, 2] }, temperature: { gte: 20 } },
    });
    expect(sql).toContain(`AND ("deviceId" IN ($4, $5) AND "temperature" >= $6)`);
    expect(params).toEqual(["1 hour", range.start, range.end, 1, 2, 20]);
  });

  it("throws on an unsupported where operator", () => {
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, where: { deviceId: { foo: 1 } } }),
    ).toThrow(/unsupported where operator/);
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
    expect(sql).toContain(`avg("temperature")::double precision AS "avgTemp"`); // unmapped column = identity
    expect(sql).toContain(`AND ("device_id" = $4)`); // where key resolved to DB column
    expect(sql).toContain(`GROUP BY "bucket", "deviceId"`); // group by the output alias
    expect(params).toEqual(["1 hour", range.start, range.end, 1]);
  });

  it("schema-qualifies the table under multiSchema (@@schema)", () => {
    const { sql } = buildTimeBucketQuery("sensor_readings", "ts", base, {}, "metrics");
    expect(sql).toContain(`FROM "metrics"."sensor_readings"`);
  });

  it("rejects an explicitly-set invalid (empty) schema rather than silently ignoring it", () => {
    expect(() => buildTimeBucketQuery("sensor_readings", "ts", base, {}, "")).toThrow(/Invalid model schema/);
  });

  it("throws when range bounds are missing", () => {
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { bucket: "1 hour", aggregate: base.aggregate } as TimeBucketRuntimeArgs),
    ).toThrow(/range\.start.+range\.end.+required/);
  });

  it("builds nested relation EXISTS from relationsByModel (multi-level where)", () => {
    const relationsByModel = new Map<string, readonly RelationConfig[]>([
      ["Reading", [{ field: "device", targetModel: "Device", table: "Device", list: false, on: [{ related: "id", outer: "deviceId" }], fk: ["deviceId"] }]],
      ["Device", [{ field: "readings", targetModel: "Reading", table: "Reading", list: true, on: [{ related: "deviceId", outer: "id" }] }]],
    ]);
    const { sql } = buildTimeBucketQuery(
      "Reading",
      "time",
      { ...base, where: { device: { is: { readings: { some: { id: 1 } } } } } },
      {},
      undefined,
      relationsByModel,
      "Reading",
    );
    expect(sql).toContain(`EXISTS (SELECT 1 FROM "Device" AS "_rel" WHERE "_rel"."id" = "Reading"."deviceId"`);
    expect(sql).toContain(`EXISTS (SELECT 1 FROM "Reading" AS "_rel2" WHERE "_rel2"."deviceId" = "_rel"."id"`);
    expect(sql).not.toContain("::regclass");
  });

  it("gapfill: true switches to time_bucket_gapfill (bounds inferred from the range WHERE)", () => {
    const { sql, params } = buildTimeBucketQuery("SensorReading", "time", { ...base, gapfill: true });
    expect(sql).toContain(`time_bucket_gapfill($1, "time") AS "bucket"`);
    expect(sql).not.toMatch(/time_bucket\(\$1/); // not the plain (non-gapfill) form
    expect(sql).toContain(`WHERE "time" >= $2 AND "time" < $3`);
    expect(params).toEqual(["1 hour", range.start, range.end]);
  });

  it("fill locf / interpolate wrap the aggregate; an unfilled aggregate stays plain", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      gapfill: true,
      aggregate: {
        carried: { avg: "temperature", fill: "locf" },
        line: { avg: "temperature", fill: "interpolate" },
        raw: { avg: "temperature" },
      },
    });
    expect(sql).toContain(`locf(avg("temperature")::double precision) AS "carried"`);
    expect(sql).toContain(`interpolate(avg("temperature")::double precision) AS "line"`);
    expect(sql).toContain(`avg("temperature")::double precision AS "raw"`);
  });

  it("locf keeps the per-fn default cast (count -> ::int, min/max native)", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      gapfill: true,
      aggregate: { c: { count: "deviceId", fill: "locf" }, m: { max: "temperature", fill: "locf" } },
    });
    expect(sql).toContain(`locf(count("deviceId")::int) AS "c"`);
    expect(sql).toContain(`locf(max("temperature")) AS "m"`);
  });

  it("rejects fill without gapfill, and fill combined with as", () => {
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, aggregate: { x: { avg: "temperature", fill: "locf" } } }),
    ).toThrow(/requires gapfill: true/);
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", {
        ...base,
        gapfill: true,
        aggregate: { x: { sum: "deviceId", as: "bigint", fill: "locf" } },
      }),
    ).toThrow(/cannot combine fill with as/);
  });

  it("rejects an invalid fill value (non-TS caller)", () => {
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", {
        ...base,
        gapfill: true,
        aggregate: { x: { avg: "temperature", fill: "ffill" } },
      }),
    ).toThrow(/invalid fill/);
  });

  it("first / last order by the time column by default; `by` overrides", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: {
        firstTemp: { first: "temperature" },
        lastTemp: { last: "temperature" },
        firstByLabel: { first: "temperature", by: "label" },
      },
    });
    expect(sql).toContain(`first("temperature", "time") AS "firstTemp"`);
    expect(sql).toContain(`last("temperature", "time") AS "lastTemp"`);
    expect(sql).toContain(`first("temperature", "label") AS "firstByLabel"`);
  });

  it("first / last resolve @map columns for both value and `by`", () => {
    const { sql } = buildTimeBucketQuery(
      "sensor_readings",
      "ts",
      { ...base, aggregate: { latest: { last: "temperature", by: "deviceId" } } },
      { deviceId: "device_id", time: "ts", temperature: "temp_c" },
    );
    expect(sql).toContain(`last("temp_c", "device_id") AS "latest"`); // both value + by mapped
  });

  it("first / last reject as and fill; `by` is rejected on other aggregates", () => {
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, aggregate: { x: { first: "temperature", as: "bigint" } } }),
    ).toThrow(/does not support as/);
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", {
        ...base,
        gapfill: true,
        aggregate: { x: { last: "temperature", fill: "locf" } },
      }),
    ).toThrow(/does not support fill/);
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, aggregate: { x: { avg: "temperature", by: "time" } } }),
    ).toThrow(/"by" is only valid on first \/ last/);
  });
});
