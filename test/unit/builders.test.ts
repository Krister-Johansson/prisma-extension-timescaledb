import { describe, expect, it } from "vitest";
import { createExtensionSql } from "../../src/core/extension.js";
import { createHypertableSql } from "../../src/core/hypertable.js";
import { createContinuousAggregateSql } from "../../src/core/continuousAggregate.js";
import { createRetentionPolicySql } from "../../src/core/retention.js";
import { createCompressionPolicySql } from "../../src/core/compression.js";
import { createChunkSkippingSql } from "../../src/core/chunkSkipping.js";
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

  it("schema-qualifies the relation under multiSchema (@@schema)", () => {
    const { up } = createHypertableSql({ table: "sensor_readings", column: "ts", chunkInterval: "1 day", schema: "metrics" });
    expect(up).toContain(`'"metrics"."sensor_readings"'`);
  });

  it("appends a reset-safe add_dimension(by_hash) for a hash space partition", () => {
    const { up } = createHypertableSql({
      table: "SensorReading",
      column: "time",
      chunkInterval: "1 day",
      spacePartition: { column: "deviceId", partitions: 4 },
    });
    expect(up).toContain("SELECT create_hypertable(");
    expect(up).toContain(`SELECT add_dimension('"SensorReading"', by_hash('deviceId', 4), if_not_exists => TRUE);`);
    // create_hypertable must come before add_dimension (the table must be a hypertable first).
    expect(up.indexOf("create_hypertable")).toBeLessThan(up.indexOf("add_dimension"));
    expect(up).not.toContain("::regclass");
  });

  it("space partition schema-qualifies the relation and maps the column (@@schema / @map)", () => {
    const { up } = createHypertableSql({
      table: "sensor_readings",
      column: "ts",
      schema: "metrics",
      spacePartition: { column: "device_id", partitions: 8 },
    });
    expect(up).toContain(`SELECT add_dimension('"metrics"."sensor_readings"', by_hash('device_id', 8), if_not_exists => TRUE);`);
  });

  it("space partition rejects a non-positive / non-integer count and a bad column", () => {
    expect(() => createHypertableSql({ table: "X", column: "t", spacePartition: { column: "d", partitions: 0 } })).toThrow(
      /positive integer/,
    );
    expect(() => createHypertableSql({ table: "X", column: "t", spacePartition: { column: "d", partitions: 2.5 } })).toThrow(
      /positive integer/,
    );
    expect(() => createHypertableSql({ table: "X", column: "t", spacePartition: { column: "a-b", partitions: 4 } })).toThrow(
      /Invalid/,
    );
  });
});

describe("createContinuousAggregateSql", () => {
  const base: CaggConfig = {
    name: "SensorHourly",
    source: "SensorReading",
    bucket: "1 hour",
    timeColumn: "time",
    bucketColumn: "bucket",
    groupBy: [{ source: "deviceId", output: "deviceId" }],
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

  it("schema-qualifies view, source, policy and down under multiSchema (@@schema)", () => {
    const sql = createContinuousAggregateSql({ ...base, schema: "metrics", sourceSchema: "metrics" });
    expect(sql.up).toContain(`CREATE MATERIALIZED VIEW IF NOT EXISTS "metrics"."SensorHourly"`);
    expect(sql.up).toContain(`FROM "metrics"."SensorReading"`);
    expect(sql.up).toContain(`add_continuous_aggregate_policy('"metrics"."SensorHourly"'`);
    expect(sql.down).toBe(`DROP MATERIALIZED VIEW IF EXISTS "metrics"."SensorHourly";`);
  });
});

describe("createRetentionPolicySql", () => {
  const sql = createRetentionPolicySql({ table: "SensorReading", dropAfter: "30 days" });

  it("matches the reset-safe add/remove retention SQL", () => {
    expect(sql.up).toBe(
      `SELECT add_retention_policy('"SensorReading"', drop_after => INTERVAL '30 days', if_not_exists => TRUE);`,
    );
    expect(sql.down).toBe(`SELECT remove_retention_policy('"SensorReading"', if_exists => TRUE);`);
  });

  it("contains NO ::regclass cast; passes the relation as a quoted string literal (constraint 2)", () => {
    expect(sql.up).not.toContain("::regclass");
    expect(sql.up).toContain(`'"SensorReading"'`);
  });

  it("is idempotent up and down (if_not_exists / if_exists)", () => {
    expect(sql.up).toContain("if_not_exists => TRUE");
    expect(sql.down).toContain("if_exists => TRUE");
  });

  it("schema-qualifies the relation under multiSchema (@@schema)", () => {
    const q = createRetentionPolicySql({ table: "sensor_readings", schema: "metrics", dropAfter: "7 days" });
    expect(q.up).toContain(`'"metrics"."sensor_readings"'`);
    expect(q.down).toContain(`'"metrics"."sensor_readings"'`);
  });

  it("rejects bad identifiers and intervals", () => {
    expect(() => createRetentionPolicySql({ table: "a-b", dropAfter: "30 days" })).toThrow(/Invalid/);
    expect(() => createRetentionPolicySql({ table: "X", dropAfter: "1 fortnight" as never })).toThrow(
      /Invalid interval/,
    );
  });
});

describe("createCompressionPolicySql", () => {
  const sql = createCompressionPolicySql({
    table: "SensorReading",
    after: "7 days",
    segmentBy: ["deviceId"],
    orderBy: [{ column: "time", direction: "desc" }],
  });

  it("enables the columnstore then adds a reset-safe columnstore policy (CALL, not SELECT)", () => {
    expect(sql.up).toBe(`ALTER TABLE "SensorReading" SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = '"deviceId"',
  timescaledb.orderby = '"time" DESC'
);
CALL add_columnstore_policy('"SensorReading"', after => INTERVAL '7 days', if_not_exists => TRUE);`);
    expect(sql.down).toBe(`CALL remove_columnstore_policy('"SensorReading"', if_exists => TRUE);`);
  });

  it("contains NO ::regclass cast; passes the policy relation as a quoted string literal (constraint 2)", () => {
    expect(sql.up).not.toContain("::regclass");
    expect(sql.up).toContain(`'"SensorReading"'`);
  });

  it("is idempotent up and down (if_not_exists / if_exists)", () => {
    expect(sql.up).toContain("if_not_exists => TRUE");
    expect(sql.down).toContain("if_exists => TRUE");
  });

  it("quotes multi-column segmentBy / orderBy identifiers to preserve case, with ASC/DESC/NULLS", () => {
    const q = createCompressionPolicySql({
      table: "T",
      after: "1 day",
      segmentBy: ["deviceId", "siteId"],
      orderBy: [
        { column: "time", direction: "desc" },
        { column: "deviceId", direction: "asc", nulls: "last" },
      ],
    });
    expect(q.up).toContain(`timescaledb.segmentby = '"deviceId", "siteId"'`);
    expect(q.up).toContain(`timescaledb.orderby = '"time" DESC, "deviceId" ASC NULLS LAST'`);
  });

  it("omits segmentby / orderby when not given (columnstore defaults)", () => {
    const q = createCompressionPolicySql({ table: "T", after: "1 day" });
    expect(q.up).toContain("timescaledb.enable_columnstore = true");
    expect(q.up).not.toContain("segmentby");
    expect(q.up).not.toContain("orderby");
  });

  it("schema-qualifies the ALTER target and the policy relation under multiSchema (@@schema)", () => {
    const q = createCompressionPolicySql({
      table: "sensor_readings",
      schema: "metrics",
      after: "7 days",
      segmentBy: ["device_id"],
    });
    expect(q.up).toContain(`ALTER TABLE "metrics"."sensor_readings" SET (`);
    expect(q.up).toContain(`CALL add_columnstore_policy('"metrics"."sensor_readings"'`);
    expect(q.down).toContain(`'"metrics"."sensor_readings"'`);
  });

  it("rejects bad identifiers and intervals", () => {
    expect(() => createCompressionPolicySql({ table: "a-b", after: "7 days" })).toThrow(/Invalid/);
    expect(() => createCompressionPolicySql({ table: "X", after: "1 fortnight" as never })).toThrow(/Invalid interval/);
    expect(() => createCompressionPolicySql({ table: "X", after: "7 days", segmentBy: ["a-b"] })).toThrow(/Invalid/);
  });

  it("rejects invalid orderBy direction / nulls in object form (fail fast, no silent coercion)", () => {
    expect(() =>
      createCompressionPolicySql({ table: "T", after: "1 day", orderBy: [{ column: "time", direction: "ascending" as never }] }),
    ).toThrow(/Invalid orderBy direction/);
    expect(() =>
      createCompressionPolicySql({ table: "T", after: "1 day", orderBy: [{ column: "time", nulls: "frist" as never }] }),
    ).toThrow(/Invalid orderBy nulls/);
  });
});

describe("createChunkSkippingSql", () => {
  const sql = createChunkSkippingSql({ table: "SensorReading", columns: ["eventId"] });

  it("wraps enable_chunk_skipping in a DO block that first turns the GUC on (SET LOCAL)", () => {
    // The GUC `timescaledb.enable_chunk_skipping` must be on for the function to be callable;
    // doing it as `SET LOCAL` inside one DO block keeps it self-contained and works whether or
    // not Prisma wraps the migration in a transaction (verified empirically against 2.27.2).
    expect(sql.up).toBe(`DO $$ BEGIN
  SET LOCAL timescaledb.enable_chunk_skipping = on;
  PERFORM enable_chunk_skipping('"SensorReading"', 'eventId', if_not_exists => TRUE);
END $$;`);
  });

  it("is idempotent (if_not_exists) and passes the relation as a quoted string literal (no cast)", () => {
    expect(sql.up).toContain("if_not_exists => TRUE");
    expect(sql.up).toContain(`'"SensorReading"'`);
    expect(sql.up).not.toContain("::regclass");
    expect(sql.up).not.toContain("::name");
  });

  it("enables every requested column with one shared SET LOCAL", () => {
    const { up } = createChunkSkippingSql({ table: "SensorReading", columns: ["eventId", "sensorId"] });
    expect(up.match(/SET LOCAL/g)).toHaveLength(1);
    expect(up).toContain(`PERFORM enable_chunk_skipping('"SensorReading"', 'eventId', if_not_exists => TRUE);`);
    expect(up).toContain(`PERFORM enable_chunk_skipping('"SensorReading"', 'sensorId', if_not_exists => TRUE);`);
    // the GUC must be set before any enable call inside the block
    expect(up.indexOf("SET LOCAL")).toBeLessThan(up.indexOf("PERFORM enable_chunk_skipping"));
  });

  it("schema-qualifies the relation under multiSchema (@@schema)", () => {
    const { up } = createChunkSkippingSql({ table: "sensor_readings", schema: "metrics", columns: ["event_id"] });
    expect(up).toContain(`PERFORM enable_chunk_skipping('"metrics"."sensor_readings"', 'event_id', if_not_exists => TRUE);`);
  });

  it("down does not try to disable (Prisma's table drop handles it)", () => {
    expect(sql.down).toMatch(/dropping "SensorReading"/);
  });

  it("rejects bad identifiers and an empty column list", () => {
    expect(() => createChunkSkippingSql({ table: "a-b", columns: ["x"] })).toThrow(/Invalid/);
    expect(() => createChunkSkippingSql({ table: "X", schema: "a-b", columns: ["x"] })).toThrow(/Invalid/);
    expect(() => createChunkSkippingSql({ table: "X", columns: ["a-b"] })).toThrow(/Invalid/);
    expect(() => createChunkSkippingSql({ table: "X", columns: [] })).toThrow(/at least one/);
  });
});
