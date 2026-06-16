// End-to-end proof of @@schema (multiSchema): the hypertable + cagg live in a non-default
// schema ("metrics"). Proves the generator schema-qualifies its SQL and the runtime resolves
// schema-qualified relations against real TimescaleDB.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./harness.js";
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
  console.warn("\n[integration] SKIPPED: Docker is not available. The @@schema (multiSchema) checks are NOT verified.\n");
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
  @@schema("metrics")
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupBy
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "temperature")

  @@unique([deviceId, bucket])
  @@schema("metrics")
}
`;

const INIT_SQL = `-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "metrics";

-- CreateTable
CREATE TABLE "metrics"."SensorReading" (
    "time" TIMESTAMP(3) NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("deviceId","time")
);

-- CreateIndex
CREATE INDEX "SensorReading_deviceId_time_idx" ON "metrics"."SensorReading"("deviceId", "time");
`;

async function counts(h: Harness) {
  const [hyper] = await h.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM timescaledb_information.hypertables WHERE hypertable_schema = 'metrics' AND hypertable_name = 'SensorReading'",
  );
  const [cagg] = await h.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM timescaledb_information.continuous_aggregates WHERE view_schema = 'metrics' AND view_name = 'SensorHourly'",
  );
  return { hypertables: hyper?.n ?? 0, caggs: cagg?.n ?? 0 };
}

describe.skipIf(!DOCKER_OK)("@@schema / multiSchema (generated migrations + runtime)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({
      models: MODELS,
      initSql: INIT_SQL,
      previewFeatures: ["multiSchema"],
      schemas: ["public", "metrics"],
    });
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it("creates the hypertable + cagg in the non-default schema", async () => {
    expect(await counts(h)).toEqual({ hypertables: 1, caggs: 1 });
  });

  it("reproduces them after migrate reset", async () => {
    h.prisma(["migrate", "reset", "--force"]);
    expect(await counts(h)).toEqual({ hypertables: 1, caggs: 1 });
  });

  it("inserts + reads through schema-qualified relations (timeBucket, refresh, cagg view)", async () => {
    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);

    const base = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    const prisma = base.$extends(timescaledb(registry));

    try {
      await prisma.sensorReading.createMany({
        data: [
          { time: new Date("2026-06-15T10:05:00Z"), deviceId: 1, temperature: 20 },
          { time: new Date("2026-06-15T10:25:00Z"), deviceId: 1, temperature: 22 },
          { time: new Date("2026-06-15T10:45:00Z"), deviceId: 1, temperature: 24 },
          { time: new Date("2026-06-15T11:10:00Z"), deviceId: 1, temperature: 30 },
          { time: new Date("2026-06-15T10:15:00Z"), deviceId: 2, temperature: 15 },
        ],
      });

      const rows = await prisma.sensorReading.timeBucket({
        bucket: "1 hour",
        range: { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") },
        groupBy: ["deviceId"],
        aggregate: { avgTemp: { avg: "temperature" } },
      });
      expect(
        rows
          .map((r: { bucket: Date; deviceId: number; avgTemp: number }) => ({
            h: r.bucket.toISOString(),
            d: r.deviceId,
            avg: Number(r.avgTemp),
          }))
          .sort((a, b) => a.d - b.d || a.h.localeCompare(b.h)),
      ).toEqual([
        { h: "2026-06-15T10:00:00.000Z", d: 1, avg: 22 },
        { h: "2026-06-15T11:00:00.000Z", d: 1, avg: 30 },
        { h: "2026-06-15T10:00:00.000Z", d: 2, avg: 15 },
      ]);

      await prisma.$timescale.refreshContinuousAggregate("SensorHourly");
      const hourly = await prisma.sensorHourly.findMany({ orderBy: [{ deviceId: "asc" }, { bucket: "asc" }] });
      expect(
        hourly.map((r: { deviceId: number; avgTemp: number }) => ({ d: r.deviceId, avg: Number(r.avgTemp) })),
      ).toEqual([{ d: 1, avg: 22 }, { d: 1, avg: 30 }, { d: 2, avg: 15 }]);
    } finally {
      await base.$disconnect();
    }
  });
});
