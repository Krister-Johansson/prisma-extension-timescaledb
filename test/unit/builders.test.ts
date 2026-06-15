import { describe, expect, it } from "vitest";
import { createExtensionSql } from "../../src/core/extension.js";
import { createHypertableSql } from "../../src/core/hypertable.js";
import { createContinuousAggregateSql } from "../../src/core/continuousAggregate.js";
import type { CaggConfig } from "../../src/core/types.js";

describe("createExtensionSql", () => {
  it("emits an idempotent standalone extension migration", () => {
    const { up, down } = createExtensionSql();
    expect(up).toBe("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;");
    expect(up).toContain("IF NOT EXISTS");
    expect(down).toBe("DROP EXTENSION IF EXISTS timescaledb CASCADE;");
  });
});

describe("createHypertableSql", () => {
  const sql = createHypertableSql({ table: "SensorReading", column: "time", chunkInterval: "1 day" });

  it("matches the spike-proven, cast-free, idempotent form", () => {
    expect(sql.up).toBe(`SELECT create_hypertable(
  '"SensorReading"',
  by_range('time', INTERVAL '1 day'),
  if_not_exists => TRUE,
  migrate_data  => TRUE
);`);
  });

  it("contains NO ::regclass and NO ::name casts (CLAUDE.md constraint 2)", () => {
    expect(sql.up).not.toContain("::regclass");
    expect(sql.up).not.toContain("::name");
  });

  it("is idempotent and passes the relation as a quoted string literal", () => {
    expect(sql.up).toContain("if_not_exists => TRUE");
    expect(sql.up).toContain("migrate_data  => TRUE");
    expect(sql.up).toContain(`'"SensorReading"'`);
  });

  it("defaults chunkInterval to 7 days when omitted", () => {
    const def = createHypertableSql({ table: "SensorReading", column: "time" });
    expect(def.up).toContain("INTERVAL '7 days'");
  });

  it("down does not try to un-hypertable (Prisma's table drop handles it)", () => {
    expect(createHypertableSql({ table: "X", column: "t" }).down).toMatch(/dropping "X"/);
  });

  it("rejects bad identifiers and intervals", () => {
    expect(() => createHypertableSql({ table: "a-b", column: "time" })).toThrow(/Invalid/);
    expect(() => createHypertableSql({ table: "X", column: "t", chunkInterval: "1 fortnight" as never })).toThrow(/Invalid interval/);
  });
});

describe("createContinuousAggregateSql", () => {
  const base: CaggConfig = {
    name: "SensorHourly",
    source: "SensorReading",
    bucket: "1 hour",
    timeColumn: "time",
    bucketColumn: "bucket",
    groupBy: ["deviceId"],
    aggregates: [
      { name: "avgTemp", fn: "avg", column: "temperature" },
      { name: "maxTemp", fn: "max", column: "temperature" },
    ],
    refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" },
  };

  it("matches the expected create + policy SQL", () => {
    expect(createContinuousAggregateSql(base).up).toBe(`CREATE MATERIALIZED VIEW IF NOT EXISTS "SensorHourly"
  WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', "time") AS "bucket",
  "deviceId" AS "deviceId",
  avg("temperature") AS "avgTemp",
  max("temperature") AS "maxTemp"
FROM "SensorReading"
GROUP BY "bucket", "deviceId"
WITH NO DATA;

SELECT add_continuous_aggregate_policy('"SensorHourly"',
  start_offset      => INTERVAL '1 month',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE
);`);
  });

  it("is idempotent (view + policy guards)", () => {
    const { up } = createContinuousAggregateSql(base);
    expect(up).toContain("CREATE MATERIALIZED VIEW IF NOT EXISTS");
    expect(up).toContain("WITH NO DATA");
    expect(up).toContain("if_not_exists     => TRUE");
  });

  it("down uses DROP MATERIALIZED VIEW IF EXISTS, never plain DROP VIEW (constraint 4)", () => {
    const { down } = createContinuousAggregateSql(base);
    expect(down).toBe('DROP MATERIALIZED VIEW IF EXISTS "SensorHourly";');
    expect(down).not.toMatch(/DROP VIEW/);
  });

  it("omits the policy block when no refresh is given (manual refresh)", () => {
    const { refresh, ...noRefresh } = base;
    void refresh;
    const { up } = createContinuousAggregateSql(noRefresh);
    expect(up).not.toContain("add_continuous_aggregate_policy");
    expect(up.trimEnd().endsWith("WITH NO DATA;")).toBe(true);
  });

  it("supports a cagg with no groupBy columns", () => {
    const { up } = createContinuousAggregateSql({ ...base, groupBy: [] });
    expect(up).toContain("GROUP BY \"bucket\"");
    expect(up).not.toContain('"deviceId"');
  });

  it("rejects empty aggregates and unsupported functions", () => {
    expect(() => createContinuousAggregateSql({ ...base, aggregates: [] })).toThrow(/at least one aggregate/);
    expect(() =>
      createContinuousAggregateSql({ ...base, aggregates: [{ name: "x", fn: "median" as never, column: "temperature" }] }),
    ).toThrow(/Unsupported aggregate function/);
  });
});
