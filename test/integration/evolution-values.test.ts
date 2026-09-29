// Changing a VALUE on an annotation, and having the database end up with the new value.
//
// `evolution.test.ts` covers structural change: objects appearing and disappearing. This covers
// the other half, which is where TimescaleDB fights back. Re-running a policy call with
// different arguments does not update the policy:
//
//   SELECT add_retention_policy('"SensorReading"', drop_after => INTERVAL '7 days', if_not_exists => TRUE);
//   WARNING:  retention policy already exists for hypertable "SensorReading"
//   DETAIL:  A policy already exists with different arguments.
//   -> the policy still says 30 days
//
// So a changed value only lands because the generator emits an explicit removal ahead of the
// idempotent re-add. That diff is unit-tested as SQL strings; this runs it against a real
// TimescaleDB and reads the values back out of the catalog.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness, dockerAvailable } from "./harness.js";

const DOCKER_OK = dockerAvailable("Changed annotation values are NOT verified.");

const TABLE = `model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  seq         Int
  batch       Int

  @@id([deviceId, time])
}`;

const V1 = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day", chunkSkipping: "seq")
/// @timescale.retention(dropAfter: "30 days")
/// @timescale.compression(after: "7 days", segmentBy: "deviceId", orderBy: "time DESC")
${TABLE}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupBy
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "temperature")

  @@unique([deviceId, bucket])
}`;

// Every value moves at once: the chunk interval, both policies, the compression segmentby, the
// chunk-skipping column, a space dimension that did not exist, and the cagg's own definition
// (a new bucket width and an extra aggregate, which forces a drop and recreate).
const V2 = `/// @timescale.hypertable(column: "time", chunkInterval: "12 hours", chunkSkipping: "batch", partitionColumn: "deviceId", partitions: 4)
/// @timescale.retention(dropAfter: "7 days")
/// @timescale.compression(after: "2 days", segmentBy: "seq", orderBy: "time DESC")
${TABLE}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "6 hours", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "6 hours", scheduleInterval: "30 minutes" })
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupBy
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  maxTemp  Float    /// @timescale.aggregate(fn: "max", column: "temperature")

  @@unique([deviceId, bucket])
}`;

// Only the refresh policy moves. The cagg itself is untouched, so the generator removes the old
// policy and re-adds it without dropping the materialized view.
const V3 = V2.replace('scheduleInterval: "30 minutes"', 'scheduleInterval: "2 hours"');

// Issue #161: three values that used to change nothing. The partition count on the same column,
// a segmentBy that disappears (orderBy stays), and materializedOnly on a cagg that must not be
// dropped for it.
const V4 = V3.replace("partitions: 4", "partitions: 8")
  .replace('segmentBy: "seq", ', "")
  .replace('scheduleInterval: "2 hours" }', 'scheduleInterval: "2 hours" }, materializedOnly: false');

// Issue #161: turning multiSchema on re-qualifies every relation as public.X. Nothing moves in
// the database, so nothing may be dropped or re-added.
const V5 = V4.replace("\n  @@id([deviceId, time])", '\n  @@id([deviceId, time])\n  @@schema("public")').replace(
  "\n  @@unique([deviceId, bucket])",
  '\n  @@unique([deviceId, bucket])\n  @@schema("public")',
);

// Issue #161: a space dimension cannot be removed from a live hypertable.
const V6 = V5.replace(', partitionColumn: "deviceId", partitions: 8', "");

const INIT_SQL = `-- CreateTable
CREATE TABLE "SensorReading" (
    "time" TIMESTAMP(3) NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL,
    "seq" INTEGER NOT NULL,
    "batch" INTEGER NOT NULL,

    CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("deviceId","time")
);
`;

interface Snapshot {
  chunkInterval: string | null;
  partitions: number | null;
  dropAfter: string | null;
  compressAfter: string | null;
  segmentBy: string | null;
  orderBy: string | null;
  materializedOnly: boolean | null;
  chunkSkipping: string | null;
  caggBucket: string | null;
  refreshSchedule: string | null;
  refreshEndOffset: string | null;
  caggColumns: string | null;
}

/** Read every value the annotations control back out of TimescaleDB's own catalogs. */
async function snapshot(h: Harness): Promise<Snapshot> {
  const [row] = await h.query<Snapshot>(`SELECT
      (SELECT time_interval::text FROM timescaledb_information.dimensions
        WHERE hypertable_name = 'SensorReading' AND dimension_type = 'Time') AS "chunkInterval",
      (SELECT num_partitions FROM timescaledb_information.dimensions
        WHERE hypertable_name = 'SensorReading' AND dimension_type = 'Space') AS "partitions",
      (SELECT config->>'drop_after' FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_retention' AND hypertable_name = 'SensorReading') AS "dropAfter",
      (SELECT config->>'compress_after' FROM timescaledb_information.jobs
        WHERE proc_name = 'policy_compression' AND hypertable_name = 'SensorReading') AS "compressAfter",
      (SELECT segmentby FROM timescaledb_information.hypertable_columnstore_settings
        WHERE hypertable::text = '"SensorReading"') AS "segmentBy",
      (SELECT orderby FROM timescaledb_information.hypertable_columnstore_settings
        WHERE hypertable::text = '"SensorReading"') AS "orderBy",
      (SELECT materialized_only FROM timescaledb_information.continuous_aggregates
        WHERE view_name = 'SensorHourly') AS "materializedOnly",
      (SELECT string_agg(s.column_name, ',' ORDER BY s.column_name)
         FROM _timescaledb_catalog.chunk_column_stats s
         JOIN _timescaledb_catalog.hypertable h ON h.id = s.hypertable_id
        WHERE h.table_name = 'SensorReading') AS "chunkSkipping",
      (SELECT b.bucket_width::text FROM _timescaledb_catalog.continuous_aggs_bucket_function b
         JOIN _timescaledb_catalog.continuous_agg c ON c.mat_hypertable_id = b.mat_hypertable_id
        WHERE c.user_view_name = 'SensorHourly') AS "caggBucket",
      (SELECT j.schedule_interval::text FROM timescaledb_information.jobs j
         JOIN _timescaledb_catalog.continuous_agg c
           ON c.mat_hypertable_id = (j.config->>'mat_hypertable_id')::int
        WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
          AND c.user_view_name = 'SensorHourly') AS "refreshSchedule",
      (SELECT j.config->>'end_offset' FROM timescaledb_information.jobs j
         JOIN _timescaledb_catalog.continuous_agg c
           ON c.mat_hypertable_id = (j.config->>'mat_hypertable_id')::int
        WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
          AND c.user_view_name = 'SensorHourly') AS "refreshEndOffset",
      (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
         FROM pg_attribute a
        WHERE a.attrelid = '"SensorHourly"'::regclass AND a.attnum > 0 AND NOT a.attisdropped) AS "caggColumns"`);
  return row as Snapshot;
}

const AFTER_V1: Snapshot = {
  chunkInterval: "1 day",
  partitions: null,
  dropAfter: "30 days",
  compressAfter: "7 days",
  segmentBy: "deviceId",
  orderBy: '"time" DESC',
  materializedOnly: true,
  chunkSkipping: "seq",
  caggBucket: "01:00:00",
  refreshSchedule: "01:00:00",
  refreshEndOffset: "01:00:00",
  caggColumns: "bucket,deviceId,avgTemp",
};

const AFTER_V2: Snapshot = {
  chunkInterval: "12:00:00",
  partitions: 4,
  dropAfter: "7 days",
  compressAfter: "2 days",
  segmentBy: "seq",
  orderBy: '"time" DESC',
  materializedOnly: true,
  chunkSkipping: "batch",
  caggBucket: "06:00:00",
  refreshSchedule: "00:30:00",
  refreshEndOffset: "06:00:00",
  caggColumns: "bucket,deviceId,avgTemp,maxTemp",
};

const AFTER_V3: Snapshot = { ...AFTER_V2, refreshSchedule: "02:00:00" };
const AFTER_V4: Snapshot = { ...AFTER_V3, partitions: 8, segmentBy: null, materializedOnly: false };

describe.skipIf(!DOCKER_OK)("changed annotation values reach the database", () => {
  let h: Harness;

  /** Swap the schema's model section in place (the harness header stays). */
  const setModels = (models: string): void => {
    const path = join(h.projectDir, "schema.prisma");
    const current = readFileSync(path, "utf8");
    writeFileSync(path, current.slice(0, current.indexOf("\n\n/// @timescale")) + "\n\n" + models, "utf8");
  };

  beforeAll(async () => {
    h = await startHarness({ models: V1, initSql: INIT_SQL });
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
  }, 240_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("v1 deploy sets every value from the annotations", async () => {
    expect(await snapshot(h)).toEqual(AFTER_V1);
  });

  // Without the removals the re-add is a no-op with a WARNING and every value here stays at v1.
  it("v2 replaces every changed value", async () => {
    setModels(V2);
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
    expect(await snapshot(h)).toEqual(AFTER_V2);
  }, 120_000);

  // A refresh policy changing on its own must not drop the view: the materialized data would go
  // with it. The generator removes the policy and re-adds it, leaving the cagg in place.
  it("v3 replaces the refresh policy without recreating the cagg", async () => {
    const [before] = await h.query<{ oid: number }>(`SELECT '"SensorHourly"'::regclass::oid AS oid`);
    setModels(V3);
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);

    expect(await snapshot(h)).toEqual(AFTER_V3);
    const [after] = await h.query<{ oid: number }>(`SELECT '"SensorHourly"'::regclass::oid AS oid`);
    expect(after?.oid).toBe(before?.oid); // same relation, never dropped and recreated
  }, 120_000);

  // Before the fix every one of these ran clean and changed nothing: add_dimension skipped the
  // existing column, the re-added policy only SET the options still declared, and the cagg was
  // dropped and recreated empty for a flag an ALTER can set.
  it("v4 changes the partition count, drops segmentBy and flips materializedOnly, all in place", async () => {
    const [before] = await h.query<{ oid: number }>(`SELECT '"SensorHourly"'::regclass::oid AS oid`);
    setModels(V4);
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
    expect(await snapshot(h)).toEqual(AFTER_V4);
    const [after] = await h.query<{ oid: number }>(`SELECT '"SensorHourly"'::regclass::oid AS oid`);
    expect(after?.oid).toBe(before?.oid); // the flag was altered on the live view
  }, 120_000);

  /** Turn multiSchema on in the generator and datasource blocks the harness wrote. */
  const enableMultiSchema = (): void => {
    const path = join(h.projectDir, "schema.prisma");
    const current = readFileSync(path, "utf8");
    expect(current).toContain('previewFeatures = ["views"]');
    writeFileSync(
      path,
      current
        .replace('previewFeatures = ["views"]', 'previewFeatures = ["views","multiSchema"]')
        .replace('provider = "postgresql"\n}', 'provider = "postgresql"\n  schemas  = ["public"]\n}'),
      "utf8",
    );
  };

  it("v5 turns multiSchema on without dropping or re-adding anything", async () => {
    const dir = join(h.projectDir, "migrations");
    const before = readdirSync(dir).sort();
    const [oidBefore] = await h.query<{ oid: number }>(`SELECT '"SensorHourly"'::regclass::oid AS oid`);
    enableMultiSchema();
    setModels(V5);
    h.prisma(["generate"]);
    // No migration: the relations did not move. The state file now carries the qualified keys.
    expect(readdirSync(dir).sort()).toEqual(before);
    const state = JSON.parse(readFileSync(join(dir, ".prisma-extension-timescaledb.json"), "utf8")) as {
      state: { hypertables: { schema?: string }[] };
    };
    expect(state.state.hypertables[0]?.schema).toBe("public");
    h.prisma(["generate"]); // and the next run is a plain no-op
    expect(readdirSync(dir).sort()).toEqual(before);
    h.prisma(["migrate", "deploy"]);
    expect(await snapshot(h)).toEqual(AFTER_V4);
    const [oidAfter] = await h.query<{ oid: number }>(`SELECT '"SensorHourly"'::regclass::oid AS oid`);
    expect(oidAfter?.oid).toBe(oidBefore?.oid);
  }, 120_000);

  // add_dimension's if_not_exists cannot take a dimension away, and the old migration would
  // have run clean while the state file recorded the removal as done.
  it("removing the space dimension is refused at generate time, before anything is written", () => {
    const dir = join(h.projectDir, "migrations");
    const before = readdirSync(dir).sort();
    const stateBefore = readFileSync(join(dir, ".prisma-extension-timescaledb.json"), "utf8");
    setModels(V6);
    try {
      expect(() => h.prisma(["generate"])).toThrow(/space dimension on "deviceId" was removed/);
      expect(readdirSync(dir).sort()).toEqual(before);
      expect(readFileSync(join(dir, ".prisma-extension-timescaledb.json"), "utf8")).toBe(stateBefore);
    } finally {
      setModels(V5);
    }
  }, 120_000);

  it("regenerating the settled schema appends no further version", () => {
    const dir = join(h.projectDir, "migrations");
    const before = readdirSync(dir).sort();
    h.prisma(["generate"]);
    expect(readdirSync(dir).sort()).toEqual(before);
    // Four annotated states that changed the database, so exactly four objects migrations
    // (the multiSchema flip in v5 emitted none).
    expect(before.filter((n) => n.includes("timescaledb_objects"))).toEqual([
      "99999999999999_timescaledb_objects_v0001",
      "99999999999999_timescaledb_objects_v0002",
      "99999999999999_timescaledb_objects_v0003",
      "99999999999999_timescaledb_objects_v0004",
    ]);
  }, 120_000);

  // The point of the append-only chain: replaying v0001 to v0004 from an empty database
  // converges on the same final state, removals, resets and alters included.
  it("a full reset replays the whole chain and converges on v4", async () => {
    h.prisma(["migrate", "reset", "--force"]);
    h.prisma(["migrate", "deploy"]);
    expect(await snapshot(h)).toEqual(AFTER_V4);
  }, 180_000);
});
