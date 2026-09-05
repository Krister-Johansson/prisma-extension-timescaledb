// Issue #129: a project that keeps its tables out of `public`.
//
// Prisma runs migrations with `search_path` set to the datasource schema alone: the
// `?schema=data_collection` on the connection string, which is also where `_prisma_migrations`
// lands. TimescaleDB installs into `public`, so its functions are NOT on that search path and
// every unqualified call in the generated SQL fails:
//
//   ERROR: function by_range(unknown, interval) does not exist
//
// This is the whole generated surface under that search path: hypertable, space partition,
// retention, compression, chunk skipping, and a continuous aggregate whose view body calls
// `time_bucket`. `test/integration/multi-schema.test.ts` is the sibling case that keeps
// `?schema=public` and only moves the MODELS, which never exercised this.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { startHarness, type Harness, type TestPrismaClient, dockerAvailable } from "./harness.js";
import { timescaledb } from "../../src/client/index.js";
import { createHypertableSql } from "../../src/core/index.js";

const DOCKER_OK = dockerAvailable("Migrations under a non-public search path (issue #129) are NOT verified.");

const SCHEMA = "data_collection";

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day", partitionColumn: "signalMappingId", partitions: 4, chunkSkipping: "sequence")
/// @timescale.retention(dropAfter: "90 days")
/// @timescale.compression(after: "7 days", segmentBy: "signalMappingId", orderBy: "time DESC")
model Measurement {
  signalMappingId String   @map("signal_mapping_id")
  time            DateTime @db.Timestamptz(3)
  value           Float
  sequence        Int

  @@id([signalMappingId, time])
  @@map("measurements")
  @@schema("${SCHEMA}")
}

/// @timescale.continuousAggregate(source: "Measurement", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view MeasurementHourly {
  bucket          DateTime /// @timescale.bucket
  signalMappingId String   @map("signal_mapping_id") /// @timescale.groupBy
  avgValue        Float    /// @timescale.aggregate(fn: "avg", column: "value")

  @@unique([signalMappingId, bucket])
  @@map("measurements_hourly")
  @@schema("${SCHEMA}")
}
`;

const INIT_SQL = `-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "${SCHEMA}";

-- CreateTable
CREATE TABLE "${SCHEMA}"."measurements" (
    "signal_mapping_id" TEXT NOT NULL,
    "time" TIMESTAMPTZ(3) NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "sequence" INTEGER NOT NULL,

    CONSTRAINT "measurements_pkey" PRIMARY KEY ("signal_mapping_id","time")
);
`;

/** Everything the generated migration is supposed to have created, counted in one round trip. */
async function objects(h: Harness) {
  const [row] = await h.query<{
    hypertables: number;
    dimensions: number;
    caggs: number;
    retention: number;
    compression: number;
    skipping: number;
  }>(`SELECT
      (SELECT count(*)::int FROM timescaledb_information.hypertables
        WHERE hypertable_schema = $1 AND hypertable_name = 'measurements') AS hypertables,
      (SELECT count(*)::int FROM timescaledb_information.dimensions
        WHERE hypertable_schema = $1 AND hypertable_name = 'measurements') AS dimensions,
      (SELECT count(*)::int FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = $1 AND view_name = 'measurements_hourly') AS caggs,
      (SELECT count(*)::int FROM timescaledb_information.jobs
        WHERE hypertable_schema = $1 AND hypertable_name = 'measurements'
          AND proc_name = 'policy_retention') AS retention,
      (SELECT count(*)::int FROM timescaledb_information.jobs
        WHERE hypertable_schema = $1 AND hypertable_name = 'measurements'
          AND proc_name = 'policy_compression') AS compression,
      (SELECT count(*)::int FROM _timescaledb_catalog.chunk_column_stats s
        JOIN _timescaledb_catalog.hypertable h ON h.id = s.hypertable_id
        WHERE h.schema_name = $1 AND h.table_name = 'measurements'
          AND s.column_name = 'sequence') AS skipping`,
    [SCHEMA],
  );
  return row;
}

const ALL_PRESENT = { hypertables: 1, dimensions: 2, caggs: 1, retention: 1, compression: 1, skipping: 1 };

describe.skipIf(!DOCKER_OK)("migrations under a non-public search path (issue #129)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({
      models: MODELS,
      initSql: INIT_SQL,
      previewFeatures: ["multiSchema"],
      schemas: [SCHEMA],
      urlSchema: SCHEMA,
    });
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("applies every generated block: hypertable, space dimension, policies, chunk skipping, cagg", async () => {
    expect(await objects(h)).toEqual(ALL_PRESENT);
  });

  // `migrate dev` replays every migration against the shadow database, which carries the same
  // `?schema=` and so the same search path. The reported flow starts with a `migrate dev`, so
  // the shadow replay has to survive it too.
  it("passes migrate dev, which replays the migrations on the shadow database", () => {
    expect(() => h.prisma(["migrate", "dev", "--name", "noop"])).not.toThrow();
  }, 120_000);

  // The reset-safety guarantee (CLAUDE.md), now under the search path that used to break it.
  it("reproduces them after migrate reset + deploy", async () => {
    h.prisma(["migrate", "reset", "--force"]);
    h.prisma(["migrate", "deploy"]);
    expect(await objects(h)).toEqual(ALL_PRESENT);
  });

  // The extension migration sorts first, before the CREATE SCHEMA in Prisma's own init
  // migration. A bare `CREATE EXTENSION` would have followed the search path into (or at) a
  // schema that does not exist yet; it has to land in public regardless.
  it("installs the extension in public, not in the datasource schema", async () => {
    const [row] = await h.query<{ nspname: string }>(
      "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'timescaledb'",
    );
    expect(row?.nspname).toBe("public");
  });

  // The block reads the extension's schema out of pg_extension rather than assuming `public`,
  // so a database where someone installed TimescaleDB elsewhere still resolves. Run the
  // builder's own SQL against such a database, under a search path that has neither schema.
  it("resolves TimescaleDB wherever the extension actually lives, not just public", async () => {
    const admin = new pg.Client({
      host: h.container.getHost(),
      port: h.container.getMappedPort(5432),
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    await admin.connect();
    // template0: the image installs timescaledb into template1, which would pre-place it in public.
    await admin.query("CREATE DATABASE elsewhere TEMPLATE template0");
    await admin.end();

    const db = new pg.Client({
      host: h.container.getHost(),
      port: h.container.getMappedPort(5432),
      user: "postgres",
      password: "postgres",
      database: "elsewhere",
    });
    await db.connect();
    try {
      await db.query('CREATE SCHEMA "ts_ext"');
      await db.query('CREATE EXTENSION timescaledb WITH SCHEMA "ts_ext" CASCADE');
      await db.query(`CREATE SCHEMA "${SCHEMA}"`);
      await db.query(`CREATE TABLE "${SCHEMA}"."measurements" ("time" TIMESTAMPTZ NOT NULL, "value" DOUBLE PRECISION)`);
      await db.query(`SET search_path TO "${SCHEMA}"`);

      await db.query(createHypertableSql({ table: "measurements", schema: SCHEMA, column: "time", chunkInterval: "1 day" }).up);

      const { rows } = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM timescaledb_information.hypertables WHERE hypertable_schema = '${SCHEMA}'`,
      );
      expect(Number(rows[0]?.n)).toBe(1);
    } finally {
      await db.end();
    }
  }, 120_000);

  it("runs timeBucket and refreshes the cagg through the extension at runtime", async () => {
    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);

    const base = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    const prisma: TestPrismaClient = base.$extends(timescaledb(registry));

    try {
      await prisma.measurement.createMany({
        data: [
          { time: new Date("2026-06-15T10:05:00Z"), signalMappingId: "a", value: 20, sequence: 1 },
          { time: new Date("2026-06-15T10:25:00Z"), signalMappingId: "a", value: 22, sequence: 2 },
          { time: new Date("2026-06-15T11:10:00Z"), signalMappingId: "a", value: 30, sequence: 3 },
          { time: new Date("2026-06-15T10:15:00Z"), signalMappingId: "b", value: 15, sequence: 4 },
        ],
      });

      const rows = await prisma.measurement.timeBucket({
        bucket: "1 hour",
        range: { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") },
        groupBy: ["signalMappingId"],
        aggregate: { avgValue: { avg: "value" } },
      });
      expect(
        rows
          .map((r: { bucket: Date; signalMappingId: string; avgValue: number }) => ({
            h: r.bucket.toISOString(),
            s: r.signalMappingId,
            avg: Number(r.avgValue),
          }))
          .sort((a, b) => a.s.localeCompare(b.s) || a.h.localeCompare(b.h)),
      ).toEqual([
        { h: "2026-06-15T10:00:00.000Z", s: "a", avg: 21 },
        { h: "2026-06-15T11:00:00.000Z", s: "a", avg: 30 },
        { h: "2026-06-15T10:00:00.000Z", s: "b", avg: 15 },
      ]);

      await prisma.$timescale().refreshContinuousAggregate("MeasurementHourly");
      const hourly = await prisma.measurementHourly.findMany({
        orderBy: [{ signalMappingId: "asc" }, { bucket: "asc" }],
      });
      expect(
        hourly.map((r: { signalMappingId: string; avgValue: number }) => ({
          s: r.signalMappingId,
          avg: Number(r.avgValue),
        })),
      ).toEqual([{ s: "a", avg: 21 }, { s: "a", avg: 30 }, { s: "b", avg: 15 }]);

      // Chunk ops and policy management go through $executeRawUnsafe, so they resolve
      // TimescaleDB's functions purely from the connection's own search path.
      const chunks = await prisma.$timescale().showChunks("Measurement");
      expect(chunks.length).toBeGreaterThan(0);
      expect(await prisma.$timescale().hypertableSize("Measurement")).toBeGreaterThan(0);
    } finally {
      await base.$disconnect();
    }
  }, 60_000);

  // The removal blocks (`remove_retention_policy`, `remove_columnstore_policy`,
  // `disable_chunk_skipping`, `remove_continuous_aggregate_policy`) are emitted by the
  // generator directly rather than by a core builder, and they call the same unqualified
  // functions. Dropping every annotation but the hypertable exercises all of them at once.
  it("applies the removal blocks of a later objects version", async () => {
    const path = join(h.projectDir, "schema.prisma");
    const current = readFileSync(path, "utf8");
    const headerEnd = current.indexOf("\n\n/// @timescale");
    writeFileSync(
      path,
      current.slice(0, headerEnd) +
        `\n\n/// @timescale.hypertable(column: "time", chunkInterval: "1 day", partitionColumn: "signalMappingId", partitions: 4)
model Measurement {
  signalMappingId String   @map("signal_mapping_id")
  time            DateTime @db.Timestamptz(3)
  value           Float
  sequence        Int

  @@id([signalMappingId, time])
  @@map("measurements")
  @@schema("${SCHEMA}")
}
`,
      "utf8",
    );
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);

    expect(await objects(h)).toEqual({
      ...ALL_PRESENT,
      caggs: 0,
      retention: 0,
      compression: 0,
      skipping: 0,
    });
  }, 120_000);
});
