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

  it("timezone buckets in the given zone (validated + quoted, positional 3rd arg)", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", { ...base, timezone: "Europe/Stockholm" });
    expect(sql).toContain(`time_bucket($1, "time", 'Europe/Stockholm') AS "bucket"`);
  });

  it("origin emits a bare ISO literal; offset emits an INTERVAL", () => {
    const origin = new Date("2026-06-15T12:00:00.000Z");
    const o = buildTimeBucketQuery("SensorReading", "time", { ...base, origin });
    expect(o.sql).toContain(`time_bucket($1, "time", origin => '2026-06-15T12:00:00.000Z') AS "bucket"`);
    const f = buildTimeBucketQuery("SensorReading", "time", { ...base, offset: "6 hours" });
    expect(f.sql).toContain(`time_bucket($1, "time", "offset" => INTERVAL '6 hours') AS "bucket"`);
  });

  it("timezone + origin + offset compose (timezone positional, then named args)", () => {
    const origin = new Date("2026-06-15T00:00:00.000Z");
    const { sql } = buildTimeBucketQuery("SensorReading", "time", { ...base, timezone: "UTC", origin, offset: "1 hour" });
    expect(sql).toContain(
      `time_bucket($1, "time", 'UTC', origin => '2026-06-15T00:00:00.000Z', "offset" => INTERVAL '1 hour') AS "bucket"`,
    );
  });

  it("rejects bad timezone, origin+offset without timezone, and gapfill combined with modifiers", () => {
    expect(() => buildTimeBucketQuery("SensorReading", "time", { ...base, timezone: "no spaces'" })).toThrow(
      /invalid timezone/,
    );
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, origin: new Date(), offset: "1 hour" }),
    ).toThrow(/origin and offset together require a timezone/);
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, gapfill: true, timezone: "UTC" }),
    ).toThrow(/gapfill cannot be combined with timezone/);
    // non-string / invalid values from non-TS callers fail with a clear error, not a raw Type/RangeError
    expect(() => buildTimeBucketQuery("SensorReading", "time", { ...base, timezone: true as never })).toThrow(
      /invalid timezone/,
    );
    expect(() => buildTimeBucketQuery("SensorReading", "time", { ...base, origin: new Date("nope") })).toThrow(
      /must be a valid Date/,
    );
  });

  it("defaults to ORDER BY bucket ascending with no LIMIT (unchanged)", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", base);
    expect(sql.endsWith(`ORDER BY "bucket"`)).toBe(true);
    expect(sql).not.toContain("LIMIT");
  });

  it("orderBy a single key sets the direction over the output alias", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", { ...base, orderBy: { bucket: "desc" } });
    expect(sql).toContain(`GROUP BY "bucket" ORDER BY "bucket" DESC`);
  });

  it("orderBy an aggregate + limit builds top-N (LIMIT inlined as an integer)", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", { ...base, orderBy: { avgTemp: "desc" }, limit: 5 });
    expect(sql).toContain(`ORDER BY "avgTemp" DESC LIMIT 5`);
  });

  it("orderBy a groupBy column and an array gives multi-key precedence", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      groupBy: ["deviceId"],
      orderBy: [{ deviceId: "asc" }, { bucket: "desc" }],
    });
    expect(sql).toContain(`ORDER BY "deviceId" ASC, "bucket" DESC`);
  });

  it("limit alone keeps the default bucket ordering", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", { ...base, limit: 10 });
    expect(sql).toContain(`ORDER BY "bucket" LIMIT 10`);
  });

  it("rejects an unknown orderBy key, a bad direction, and a non-positive/non-integer limit", () => {
    expect(() => buildTimeBucketQuery("SensorReading", "time", { ...base, orderBy: { nope: "asc" } })).toThrow(
      /orderBy key "nope" must be/,
    );
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, orderBy: { bucket: "up" as never } }),
    ).toThrow(/must be "asc" or "desc"/);
    expect(() => buildTimeBucketQuery("SensorReading", "time", { ...base, limit: 0 })).toThrow(
      /limit must be a positive integer/,
    );
    expect(() => buildTimeBucketQuery("SensorReading", "time", { ...base, limit: 2.5 })).toThrow(
      /limit must be a positive integer/,
    );
  });

  it("rejects a malformed (non-object) orderBy entry with a structured error, not a raw TypeError", () => {
    expect(() => buildTimeBucketQuery("SensorReading", "time", { ...base, orderBy: [null as never] })).toThrow(
      /each orderBy entry must be an object/,
    );
  });

  it("stddev / variance (+ pop variants) cast to double precision; as: string keeps the exact decimal", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: {
        sd: { stddev: "temperature" },
        sdp: { stddevPop: "temperature" },
        v: { variance: "temperature" },
        vp: { varPop: "temperature" },
        exact: { stddev: "temperature", as: "string" },
      },
    });
    expect(sql).toContain(`stddev("temperature")::double precision AS "sd"`);
    expect(sql).toContain(`stddev_pop("temperature")::double precision AS "sdp"`);
    expect(sql).toContain(`variance("temperature")::double precision AS "v"`);
    expect(sql).toContain(`var_pop("temperature")::double precision AS "vp"`);
    expect(sql).toContain(`stddev("temperature")::text AS "exact"`);
  });

  it("count distinct emits count(DISTINCT col)", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: { u: { count: "deviceId", distinct: true }, n: { count: "deviceId" } },
    });
    expect(sql).toContain(`count(DISTINCT "deviceId")::int AS "u"`);
    expect(sql).toContain(`count("deviceId")::int AS "n"`);
  });

  it("histogram emits histogram(col, min, max, buckets) with inlined numeric params", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: { h: { histogram: "temperature", min: 0, max: 100, buckets: 5 } },
    });
    expect(sql).toContain(`histogram("temperature", 0, 100, 5) AS "h"`);
  });

  it("rejects invalid stat / distinct / histogram combinations", () => {
    const bad = (aggregate: Record<string, Record<string, unknown>>) =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, aggregate });
    expect(() => bad({ h: { histogram: "temperature", min: 0, max: 1, buckets: 2, as: "string" } })).toThrow(
      /"histogram" on "h" does not support as/,
    );
    expect(() => bad({ x: { avg: "temperature", distinct: true } })).toThrow(/"distinct" is only valid on count/);
    expect(() => bad({ h: { histogram: "temperature", min: 0, max: 1, buckets: 0 } })).toThrow(
      /buckets must be a positive integer/,
    );
    expect(() => bad({ h: { histogram: "temperature", min: 5, max: 5, buckets: 2 } })).toThrow(/requires min < max/);
    // `min` is itself a function name, so a stray histogram param on another fn reads as two functions.
    expect(() => bad({ x: { avg: "temperature", min: 0 } })).toThrow(/exactly one function/);
    expect(() => bad({ x: { stddev: "temperature", as: "bigint" } })).toThrow(/is not valid for "stddev"/);
    // a non-boolean distinct, distinct on a non-count, and an extra key in a histogram spec
    expect(() => bad({ x: { count: "deviceId", distinct: "yes" } })).toThrow(/distinct on "x" must be a boolean/);
    expect(() => bad({ x: { first: "temperature", distinct: true } })).toThrow(/"distinct" is only valid on count/);
    expect(() => bad({ h: { histogram: "temperature", min: 0, max: 1, buckets: 2, sum: "temperature" } })).toThrow(
      /unexpected key/,
    );
  });

  it("percentile emits approx_percentile(p, percentile_agg(col))", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: { p95: { percentile: "temperature", p: 0.95 } },
    });
    expect(sql).toContain(`approx_percentile(0.95, percentile_agg("temperature")) AS "p95"`);
  });

  it("rejects a bad/missing percentile p, p on a non-percentile, and as/fill on percentile", () => {
    const bad = (aggregate: Record<string, Record<string, unknown>>) =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, aggregate });
    expect(() => bad({ x: { percentile: "temperature", p: 1.5 } })).toThrow(/p as a number in \[0, 1\]/);
    expect(() => bad({ x: { percentile: "temperature" } })).toThrow(/p as a number in \[0, 1\]/); // missing p
    expect(() => bad({ x: { avg: "temperature", p: 0.5 } })).toThrow(/"p" is only valid on percentile/);
    expect(() => bad({ x: { percentile: "temperature", p: 0.5, as: "string" } })).toThrow(/does not support as/);
    expect(() => bad({ h: { histogram: "temperature", min: 0, max: 1, buckets: 2, p: 0.5 } })).toThrow(
      /does not support as \/ fill \/ by \/ distinct \/ p/,
    );
  });

  it("counter rate / delta wrap counter_agg over the time column", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: { r: { rate: "temperature" }, d: { delta: "temperature" } },
    });
    expect(sql).toContain(`rate(counter_agg("time", "temperature")) AS "r"`);
    expect(sql).toContain(`delta(counter_agg("time", "temperature")) AS "d"`);
  });

  it("timeWeightedAverage wraps average(time_weight(method, time, col)); default LOCF, linear opt-in", () => {
    const def = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: { twa: { timeWeightedAverage: "temperature" } },
    });
    expect(def.sql).toContain(`average(time_weight('LOCF', "time", "temperature")) AS "twa"`);
    const lin = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: { twa: { timeWeightedAverage: "temperature", method: "linear" } },
    });
    expect(lin.sql).toContain(`average(time_weight('Linear', "time", "temperature")) AS "twa"`);
  });

  it("rejects a bad method, and method / p / as on the wrong function", () => {
    const bad = (aggregate: Record<string, Record<string, unknown>>) =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, aggregate });
    expect(() => bad({ x: { timeWeightedAverage: "temperature", method: "ewma" } })).toThrow(
      /method must be "locf" or "linear"/,
    );
    expect(() => bad({ x: { avg: "temperature", method: "locf" } })).toThrow(
      /"method" is only valid on timeWeightedAverage/,
    );
    expect(() => bad({ x: { rate: "temperature", p: 0.5 } })).toThrow(/"p" is only valid on percentile/);
    expect(() => bad({ x: { rate: "temperature", as: "string" } })).toThrow(/"rate" on "x" does not support as/);
  });

  it("candlestick emits jsonb_build_object over a single candlestick_agg(time, price, volume)", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: { c: { candlestick: "price", volume: "vol" } },
    });
    expect(sql).toContain(`jsonb_build_object('open', open(candlestick_agg("time", "price", "vol"))`);
    expect(sql).toContain(`'close', close(candlestick_agg("time", "price", "vol"))`);
    expect(sql).toContain(`'vwap', vwap(candlestick_agg("time", "price", "vol"))) AS "c"`);
  });

  it("rejects candlestick without volume, with gapfill, and volume on a non-candlestick", () => {
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, aggregate: { c: { candlestick: "price" } } }),
    ).toThrow(/candlestick "c" requires a volume column/);
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", {
        ...base,
        gapfill: true,
        aggregate: { c: { candlestick: "price", volume: "vol" } },
      }),
    ).toThrow(/cannot be combined with gapfill/);
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, aggregate: { x: { avg: "temperature", volume: "vol" } } }),
    ).toThrow(/"volume" is only valid on candlestick/);
  });

  it("stats emits jsonb_build_object over a single stats_agg(value)", () => {
    const { sql } = buildTimeBucketQuery("SensorReading", "time", {
      ...base,
      aggregate: { s: { stats: "temperature" } },
    });
    expect(sql).toContain(`jsonb_build_object('average', average(stats_agg("temperature"))`);
    expect(sql).toContain(`'numVals', num_vals(stats_agg("temperature"))`);
    expect(sql).toContain(`'stddev', stddev(stats_agg("temperature"))`);
    expect(sql).toContain(`'kurtosis', kurtosis(stats_agg("temperature"))) AS "s"`);
  });

  it("rejects stats with as / fill and stats + gapfill", () => {
    const bad = (aggregate: Record<string, Record<string, unknown>>) =>
      buildTimeBucketQuery("SensorReading", "time", { ...base, aggregate });
    expect(() => bad({ s: { stats: "temperature", as: "string" } })).toThrow(
      /"stats" on "s" does not support as/,
    );
    expect(() =>
      buildTimeBucketQuery("SensorReading", "time", {
        ...base,
        gapfill: true,
        aggregate: { s: { stats: "temperature" } },
      }),
    ).toThrow(/cannot be combined with gapfill/);
  });
});
