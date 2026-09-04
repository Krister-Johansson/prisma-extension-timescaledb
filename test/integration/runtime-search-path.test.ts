// The runtime half of the search-path problem (the migration half is non-public-search-path.test.ts).
//
// `timeBucket` and `$timescale` send raw SQL that names `time_bucket`, `show_chunks`,
// `stats_agg` and the rest without a schema, so they resolve through the connection's
// `search_path`. `ALTER ROLE app SET search_path TO data_collection` is ordinary practice in a
// database shared by several services, and it reaches every connection Prisma opens:
//
//   ERROR: function time_bucket(unknown, timestamp with time zone) does not exist
//
// Prisma's own queries survive it, because the engine schema-qualifies the relations it
// generates. This covers the raw SQL, which does not.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness, type TestPrismaClient } from "./harness.js";
import { timescaledb } from "../../src/client/index.js";

const DOCKER_OK = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!DOCKER_OK) {
  console.warn(
    "\n[integration] SKIPPED runtime-search-path.test.ts: Docker is not available. Runtime queries under a narrowed search path are NOT verified.\n",
  );
}

// The tables live in the service's own schema and the search path points at them, which is what
// `?schema=data_collection` plus a matching role default gives you. Relations therefore still
// resolve; TimescaleDB, which installs into `public`, is what falls off the path.
const SCHEMA = "data_collection";

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  volume      Float

  @@id([deviceId, time])
  @@schema("${SCHEMA}")
}`;

const INIT_SQL = `-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "${SCHEMA}";

-- CreateTable
CREATE TABLE "${SCHEMA}"."SensorReading" (
    "time" TIMESTAMP(3) NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("deviceId","time")
);
`;

const ROWS = [
  { time: new Date("2026-06-15T10:05:00Z"), deviceId: 1, temperature: 20, volume: 5 },
  { time: new Date("2026-06-15T10:25:00Z"), deviceId: 1, temperature: 22, volume: 7 },
  { time: new Date("2026-06-15T10:45:00Z"), deviceId: 1, temperature: 24, volume: 9 },
  { time: new Date("2026-06-15T11:10:00Z"), deviceId: 1, temperature: 30, volume: 3 },
];
const RANGE = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") };

describe.skipIf(!DOCKER_OK)("runtime queries under a narrowed search path", () => {
  let h: Harness;
  let base: { $disconnect(): Promise<void> };
  let prisma: TestPrismaClient;

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

    // What a DBA does in a database shared by several services. It is a role default, so it
    // applies to every connection Prisma opens from here on, including the pool it builds below.
    await h.query(`ALTER ROLE postgres SET search_path TO "${SCHEMA}"`);

    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);
    const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    base = client;
    prisma = client.$extends(timescaledb(registry));
    await prisma.sensorReading.createMany({ data: ROWS });
  }, 240_000);

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("the connection really does not have the extension on its search path", async () => {
    const [row] = await prisma.$queryRawUnsafe<{ search_path: string }[]>("SHOW search_path");
    expect(row?.search_path).toBe(SCHEMA);
    const [visible] = await prisma.$queryRawUnsafe<{ v: boolean }[]>(
      "SELECT to_regprocedure('time_bucket(interval, timestamp with time zone)') IS NOT NULL AS v",
    );
    expect(visible?.v).toBe(false);
  });

  it("runs timeBucket", async () => {
    const rows = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range: RANGE,
      groupBy: ["deviceId"],
      aggregate: { avgTemp: { avg: "temperature" } },
    });
    expect(
      rows.map((r: { bucket: Date; avgTemp: number }) => ({ h: r.bucket.toISOString(), avg: Number(r.avgTemp) })),
    ).toEqual([
      { h: "2026-06-15T10:00:00.000Z", avg: 22 },
      { h: "2026-06-15T11:00:00.000Z", avg: 30 },
    ]);
  });

  // time_bucket_gapfill, locf and interpolate are core TimescaleDB; first/last too.
  it("runs the gap-filling and first/last forms", async () => {
    const rows = await prisma.sensorReading.timeBucket({
      bucket: "30 minutes",
      range: RANGE,
      gapfill: true,
      aggregate: {
        carried: { avg: "temperature", fill: "locf" },
        lerped: { avg: "temperature", fill: "interpolate" },
        firstTemp: { first: "temperature" },
        lastTemp: { last: "temperature" },
      },
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  // The Toolkit hyperfunctions come from a second extension, timescaledb_toolkit, which can sit
  // in a schema of its own and is probed separately.
  it("runs the Toolkit hyperfunctions", async () => {
    const rows = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range: RANGE,
      aggregate: {
        p90: { percentile: "temperature", p: 0.9 },
        rate: { rate: "temperature" },
        weighted: { timeWeightedAverage: "temperature" },
        ohlc: { candlestick: "temperature", volume: "volume" },
        summary: { stats: "temperature" },
      },
    });
    expect(rows.length).toBe(2);
    const first = rows[0] as { ohlc: { open: number }; summary: { average: number }; p90: number };
    expect(first.ohlc.open).toBe(20);
    expect(Number(first.summary.average)).toBe(22);
    expect(Number(first.p90)).toBeGreaterThan(0);
  });

  it("runs the $timescale management helpers", async () => {
    const ts = prisma.$timescale();

    expect((await ts.showChunks("SensorReading")).length).toBeGreaterThan(0);
    expect(await ts.hypertableSize("SensorReading")).toBeGreaterThan(0);
    expect(await ts.approximateRowCount("SensorReading")).toBeGreaterThanOrEqual(0n);

    await ts.addRetentionPolicy("SensorReading", { dropAfter: "30 days" });
    await ts.addCompressionPolicy("SensorReading", { after: "7 days", segmentBy: "deviceId" });
    await ts.setChunkInterval("SensorReading", "12 hours");

    const jobs = await ts.listJobs("SensorReading");
    expect(jobs.map((j: { procName: string }) => j.procName).sort()).toEqual([
      "policy_compression",
      "policy_retention",
    ]);

    const [chunk] = await ts.showChunks("SensorReading");
    await ts.compressChunk(chunk);
    await ts.decompressChunk(chunk);

    await ts.removeCompressionPolicy("SensorReading");
    await ts.removeRetentionPolicy("SensorReading");
    expect(await ts.listJobs("SensorReading")).toEqual([]);

    expect((await ts.dropChunks("SensorReading", { olderThan: "1 second" })).length).toBeGreaterThan(0);
  }, 120_000);

  // $timescale() bound to a transaction client must resolve the prefix too, and reuse the probe
  // rather than paying for one per transaction.
  it("works inside an interactive transaction", async () => {
    const size = await prisma.$transaction(async (tx: TestPrismaClient) => {
      await tx.sensorReading.createMany({
        data: [{ time: new Date("2026-06-15T12:00:00Z"), deviceId: 2, temperature: 19, volume: 1 }],
      });
      return tx.$timescale().hypertableSize("SensorReading");
    });
    expect(size).toBeGreaterThan(0);
  });
});
