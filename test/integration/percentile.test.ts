// Approximate percentiles in timeBucket, end-to-end on real TimescaleDB (Toolkit hyperfunctions):
// { percentile: col, p } -> approx_percentile(p, percentile_agg(col)). Requires the
// timescaledb_toolkit extension, which the test harness's `-ha` image provides. Values 1..100 in one
// bucket make p50/p95 predictable (approximate, so asserted within a tolerance).
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
  console.warn("\n[integration] SKIPPED percentile.test.ts: Docker is not available. Not verified.\n");
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}`;

const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") };

describe.skipIf(!DOCKER_OK)("timeBucket approximate percentiles (real TimescaleDB Toolkit)", () => {
  let h: Harness;
  // deno-lint-ignore no-explicit-any
  let prisma: any;
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

    // 100 readings (temperatures 1..100) within a single daily bucket.
    await prisma.sensorReading.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        deviceId: 1,
        time: new Date(range.start.getTime() + i * 60_000),
        temperature: i + 1,
      })),
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("computes approximate p50 / p95 as numbers", async () => {
    const [row] = await prisma.sensorReading.timeBucket({
      bucket: "1 day",
      range,
      aggregate: {
        p50: { percentile: "temperature", p: 0.5 },
        p95: { percentile: "temperature", p: 0.95 },
      },
    });
    expect(typeof row.p50).toBe("number");
    expect(typeof row.p95).toBe("number");
    // Approximate (uddsketch): p50 ~ 50, p95 ~ 95 over 1..100. Generous tolerance for the sketch.
    expect(row.p50).toBeGreaterThan(45);
    expect(row.p50).toBeLessThan(56);
    expect(row.p95).toBeGreaterThan(90);
    expect(row.p95).toBeLessThan(99);
    expect(row.p95).toBeGreaterThan(row.p50);
  });
});
