// Toolkit stats_agg (1-D) in timeBucket, end-to-end on real TimescaleDB (the `-ha` image carries
// timescaledb_toolkit). One op returns the 1-D statistical summary as a JS object per bucket
// (jsonb_build_object over a single stats_agg(value)). Three values make the moments predictable.
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
  console.warn("\n[integration] SKIPPED stats.test.ts: Docker is not available. Not verified.\n");
}

const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-15T01:00:00Z") };

describe.skipIf(!DOCKER_OK)("timeBucket stats_agg / 1-D summary (real TimescaleDB Toolkit)", () => {
  let h: Harness;
  // deno-lint-ignore no-explicit-any
  let prisma: any;
  let base: { $disconnect(): Promise<void> };

  beforeAll(async () => {
    h = await startHarness();
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);

    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);
    base = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    prisma = (base as { $extends: (e: unknown) => unknown }).$extends(timescaledb(registry));

    // Three readings within one hour: 10, 20, 30 — symmetric, so the moments are exact.
    await prisma.sensorReading.createMany({
      data: [
        { deviceId: 1, time: new Date("2026-06-15T00:00:00Z"), temperature: 10 },
        { deviceId: 1, time: new Date("2026-06-15T00:30:00Z"), temperature: 20 },
        { deviceId: 1, time: new Date("2026-06-15T00:45:00Z"), temperature: 30 },
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("returns the 1-D statistical summary as an object per bucket", async () => {
    const [row] = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range,
      groupBy: ["deviceId"],
      aggregate: { temp: { stats: "temperature" } },
    });
    const s = row.temp;
    expect(s.sum).toBe(60);
    expect(s.numVals).toBe(3);
    expect(s.average).toBeCloseTo(20, 6);
    // Population (Toolkit default): variance = ((10-20)^2 + 0 + (30-20)^2) / 3 = 200/3 ≈ 66.667;
    // stddev = sqrt(200/3) ≈ 8.165. Symmetric data → skewness 0.
    expect(s.variance).toBeCloseTo(66.667, 2);
    expect(s.stddev).toBeCloseTo(8.165, 2);
    expect(s.skewness).toBeCloseTo(0, 5);
    // kurtosis convention (raw vs excess) is a Toolkit detail — just assert it computed.
    expect(typeof s.kurtosis).toBe("number");
    expect(Number.isFinite(s.kurtosis)).toBe(true);
  });
});
