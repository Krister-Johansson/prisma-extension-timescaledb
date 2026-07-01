// Gap-filling in timeBucket, end-to-end on real TimescaleDB: gapfill: true emits a row for every
// bucket across the range (via time_bucket_gapfill, bounds inferred from the range WHERE), and the
// per-aggregate fill modes carry forward (locf) / interpolate empty buckets. Values verified
// against a known gap (bucket 01:00 has no data between 00:00 and 02:00).
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
  console.warn("\n[integration] SKIPPED gapfill.test.ts: Docker is not available. Gap-filling is NOT verified.\n");
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}`;

const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-15T03:00:00Z") };

describe.skipIf(!DOCKER_OK)("timeBucket gap-filling (real TimescaleDB)", () => {
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

    // Bucket 00:00 -> avg 15; 01:00 -> GAP (no rows); 02:00 -> avg 40.
    await prisma.sensorReading.createMany({
      data: [
        { deviceId: 1, time: new Date("2026-06-15T00:30:00Z"), temperature: 10 },
        { deviceId: 1, time: new Date("2026-06-15T00:45:00Z"), temperature: 20 },
        { deviceId: 1, time: new Date("2026-06-15T02:15:00Z"), temperature: 40 },
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("emits empty buckets and fills them with locf / interpolate", async () => {
    const rows = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range,
      gapfill: true,
      aggregate: {
        raw: { avg: "temperature" },
        carried: { avg: "temperature", fill: "locf" },
        line: { avg: "temperature", fill: "interpolate" },
      },
    });
    // Three hourly buckets across the range, even though 01:00 has no data.
    expect(rows).toHaveLength(3);
    const [b0, b1, b2] = rows;
    expect(b0).toMatchObject({ raw: 15, carried: 15, line: 15 });
    expect(b1.raw).toBeNull(); // empty bucket -> null raw aggregate
    expect(b1.carried).toBe(15); // last observation carried forward
    expect(b1.line).toBe(27.5); // linear interpolation between 15 and 40
    expect(b2).toMatchObject({ raw: 40, carried: 40, line: 40 });
  });

  it("without gapfill, only buckets that have data are returned", async () => {
    const rows = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range,
      aggregate: { raw: { avg: "temperature" } },
    });
    expect(rows).toHaveLength(2); // 00:00 and 02:00 only — no row for the empty 01:00 bucket
  });
});
