// End-to-end proof that @@map / @map work: a fully renamed schema (table "sensor_readings",
// columns "ts"/"device_id", view "sensor_hourly", "avg_temp"). Proves the generator emits
// DB-mapped SQL and the runtime resolves Prisma names -> DB names against real TimescaleDB.
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
  console.warn(
    "\n[integration] SKIPPED: Docker is not available. The @@map/@map reset-safety + runtime checks are NOT verified.\n",
  );
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime @map("ts")
  deviceId    Int      @map("device_id")
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
  @@map("sensor_readings")
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      @map("device_id") /// @timescale.groupBy
  avgTemp  Float    @map("avg_temp")  /// @timescale.aggregate(fn: "avg", column: "temperature")

  @@unique([deviceId, bucket])
  @@map("sensor_hourly")
}
`;

const INIT_SQL = `-- CreateTable
CREATE TABLE "sensor_readings" (
    "ts" TIMESTAMP(3) NOT NULL,
    "device_id" INTEGER NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "sensor_readings_pkey" PRIMARY KEY ("device_id","ts")
);

-- CreateIndex
CREATE INDEX "sensor_readings_device_id_ts_idx" ON "sensor_readings"("device_id", "ts");
`;

describe.skipIf(!DOCKER_OK)("@@map / @map (generated migrations + runtime)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ models: MODELS, initSql: INIT_SQL });
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it("creates the hypertable + cagg under their mapped DB names", async () => {
    const [hyper] = await h.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM timescaledb_information.hypertables WHERE hypertable_name = 'sensor_readings'",
    );
    const [cagg] = await h.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM timescaledb_information.continuous_aggregates WHERE view_name = 'sensor_hourly'",
    );
    expect({ hypertables: hyper?.n, caggs: cagg?.n }).toEqual({ hypertables: 1, caggs: 1 });
  });

  it("reproduces the mapped hypertable + cagg after migrate reset", async () => {
    // reset drops the DB and replays all migrations (re-running our deterministic generator).
    h.prisma(["migrate", "reset", "--force"]);
    const [hyper] = await h.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM timescaledb_information.hypertables WHERE hypertable_name = 'sensor_readings'",
    );
    const [cagg] = await h.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM timescaledb_information.continuous_aggregates WHERE view_name = 'sensor_hourly'",
    );
    expect({ hypertables: hyper?.n, caggs: cagg?.n }).toEqual({ hypertables: 1, caggs: 1 });
  });

  it("inserts + reads through the mapped names via timeBucket, refresh and the cagg view", async () => {
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

      // Prisma field names in -> Prisma field names out, even though the DB uses ts/device_id.
      const rows = await prisma.sensorReading.timeBucket({
        bucket: "1 hour",
        range: { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") },
        where: { deviceId: 1 },
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
          .sort((a, b) => a.h.localeCompare(b.h)),
      ).toEqual([
        { h: "2026-06-15T10:00:00.000Z", d: 1, avg: 22 },
        { h: "2026-06-15T11:00:00.000Z", d: 1, avg: 30 },
      ]);

      // Model name "SensorHourly" resolves to the DB view "sensor_hourly".
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
