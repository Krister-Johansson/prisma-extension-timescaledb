// Standard aggregates in timeBucket, end-to-end on real TimescaleDB: stddev / variance (+ pop),
// count(distinct), and histogram. Verifies both the computed values and the JS return shapes
// (numbers for the stats, a real number[] for histogram) through @prisma/adapter-pg.
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
  console.warn("\n[integration] SKIPPED aggregates.test.ts: Docker is not available. Not verified.\n");
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

describe.skipIf(!DOCKER_OK)("timeBucket standard aggregates (real TimescaleDB)", () => {
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

    // One bucket: temps [10, 20, 30]; devices {1, 2} (2 distinct).
    await prisma.sensorReading.createMany({
      data: [
        { deviceId: 1, time: new Date("2026-06-15T00:10:00Z"), temperature: 10 },
        { deviceId: 2, time: new Date("2026-06-15T00:20:00Z"), temperature: 20 },
        { deviceId: 2, time: new Date("2026-06-15T00:30:00Z"), temperature: 30 },
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("computes stddev / variance (+ pop) and count(distinct) as numbers", async () => {
    const [row] = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range,
      aggregate: {
        sd: { stddev: "temperature" },
        v: { variance: "temperature" },
        sdp: { stddevPop: "temperature" },
        vp: { varPop: "temperature" },
        devices: { count: "deviceId", distinct: true },
        n: { count: "deviceId" },
      },
    });
    // [10,20,30]: sample sd=10, sample var=100, pop var=200/3, pop sd=sqrt(200/3).
    expect(row.sd).toBeCloseTo(10, 6);
    expect(row.v).toBeCloseTo(100, 6);
    expect(row.vp).toBeCloseTo(200 / 3, 6);
    expect(row.sdp).toBeCloseTo(Math.sqrt(200 / 3), 6);
    expect(typeof row.sd).toBe("number");
    expect(row.devices).toBe(2); // distinct devices {1,2}
    expect(row.n).toBe(3); // total rows
  });

  it("returns histogram as a JS number[] of buckets+2 counts", async () => {
    const [row] = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range,
      aggregate: { h: { histogram: "temperature", min: 0, max: 60, buckets: 3 } },
    });
    // 3 buckets of width 20 over [0,60): 10->b0, 20->b1, 30->b1; plus below/above overflow bins.
    expect(Array.isArray(row.h)).toBe(true);
    expect(row.h).toEqual([0, 1, 2, 0, 0]);
    expect(row.h.every((n: unknown) => typeof n === "number")).toBe(true);
  });
});
