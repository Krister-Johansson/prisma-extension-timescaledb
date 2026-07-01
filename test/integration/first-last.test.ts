// first() / last() aggregates in timeBucket, end-to-end on real TimescaleDB: the value of one
// column at the earliest / latest time in each bucket (ordered by the model's time column by
// default). Verified for a numeric and a text column against known per-bucket extremes.
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
  console.warn("\n[integration] SKIPPED first-last.test.ts: Docker is not available. first/last are NOT verified.\n");
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  label       String

  @@id([deviceId, time])
}`;

const INIT_SQL = `CREATE TABLE "SensorReading" (
  "time" TIMESTAMP(3) NOT NULL,
  "deviceId" INTEGER NOT NULL,
  "temperature" DOUBLE PRECISION NOT NULL,
  "label" TEXT NOT NULL,
  CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("deviceId","time")
);`;

const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-15T01:00:00Z") };

describe.skipIf(!DOCKER_OK)("timeBucket first / last (real TimescaleDB)", () => {
  let h: Harness;
  let prisma: TestPrismaClient;
  let base: { $disconnect(): Promise<void> };

  beforeAll(async () => {
    h = await startHarness({ models: MODELS, initSql: INIT_SQL });
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);

    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);
    base = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    prisma = (base as { $extends: (e: unknown) => unknown }).$extends(timescaledb(registry));

    // Within the 00:00 bucket: earliest 00:10 (temp 10, "a"), latest 00:50 (temp 20, "b").
    await prisma.sensorReading.createMany({
      data: [
        { deviceId: 1, time: new Date("2026-06-15T00:10:00Z"), temperature: 10, label: "a" },
        { deviceId: 1, time: new Date("2026-06-15T00:30:00Z"), temperature: 15, label: "c" },
        { deviceId: 1, time: new Date("2026-06-15T00:50:00Z"), temperature: 20, label: "b" },
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("returns the value at the earliest / latest time per bucket (numeric and text)", async () => {
    const rows = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range,
      groupBy: ["deviceId"],
      aggregate: {
        firstTemp: { first: "temperature" },
        lastTemp: { last: "temperature" },
        firstLabel: { first: "label" },
        lastLabel: { last: "label" },
      },
    });
    expect(rows).toHaveLength(1);
    // first/last are by time (default), NOT by value — so lastLabel is "b" (at 00:50), not "c".
    expect(rows[0]).toMatchObject({
      deviceId: 1,
      firstTemp: 10,
      lastTemp: 20,
      firstLabel: "a",
      lastLabel: "b",
    });
  });
});
