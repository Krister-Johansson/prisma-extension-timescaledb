// Toolkit counter_agg (rate / delta) and time-weighted average in timeBucket, end-to-end on real
// TimescaleDB (the `-ha` image carries timescaledb_toolkit). A counter that RESETS mid-bucket proves
// reset-awareness: a naive last-first delta would be ~50, but reset-aware delta is 350.
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
  console.warn("\n[integration] SKIPPED counter-timeweight.test.ts: Docker is not available. Not verified.\n");
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}`;

const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-15T01:00:00Z") };

describe.skipIf(!DOCKER_OK)("timeBucket counter_agg + time_weight (real TimescaleDB Toolkit)", () => {
  let h: Harness;
  let prisma: TestPrismaClient;
  let base: { $disconnect(): Promise<void> };

  beforeAll(async () => {
    h = await startHarness({ models: MODELS });
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);

    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);
    base = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    prisma = (base as { $extends: (e: unknown) => unknown }).$extends(timescaledb(registry));

    // A counter: 100, 200, 300, then RESET to 50, 150 — all within one hour.
    await prisma.sensorReading.createMany({
      data: [
        { deviceId: 1, time: new Date("2026-06-15T00:00:00Z"), temperature: 100 },
        { deviceId: 1, time: new Date("2026-06-15T00:15:00Z"), temperature: 200 },
        { deviceId: 1, time: new Date("2026-06-15T00:30:00Z"), temperature: 300 },
        { deviceId: 1, time: new Date("2026-06-15T00:45:00Z"), temperature: 50 },
        { deviceId: 1, time: new Date("2026-06-15T00:59:00Z"), temperature: 150 },
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("computes reset-aware rate / delta and a time-weighted average as numbers", async () => {
    const [row] = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range,
      aggregate: {
        ratePerSec: { rate: "temperature" },
        totalDelta: { delta: "temperature" },
        twAvg: { timeWeightedAverage: "temperature" },
      },
    });
    expect(typeof row.ratePerSec).toBe("number");
    expect(typeof row.totalDelta).toBe("number");
    expect(typeof row.twAvg).toBe("number");
    // Reset-aware total change over the bucket (a naive last-minus-first would be ~50).
    expect(row.totalDelta).toBeCloseTo(350, 5);
    // rate = delta / observed span. First..last point span = 00:00..00:59 = 3540s.
    expect(row.ratePerSec).toBeCloseTo(350 / 3540, 3);
    // Time-weighted (LOCF) average is 164.4 — distinct from the simple mean of these values (160),
    // so this specifically validates the time-weighting (not just "some number in range").
    expect(row.twAvg).toBeCloseTo(164.4, 0);
  });
});
