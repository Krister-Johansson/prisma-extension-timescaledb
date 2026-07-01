// timeBucket orderBy + limit, end-to-end on real TimescaleDB: order by the bucket (asc/desc) or by
// an aggregate, and cap rows with limit — i.e. "latest N buckets" and "top N buckets by value".
// Three hourly buckets with distinct averages make the ordering unambiguous.
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
  console.warn("\n[integration] SKIPPED order-limit.test.ts: Docker is not available. Not verified.\n");
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

describe.skipIf(!DOCKER_OK)("timeBucket orderBy + limit (real TimescaleDB)", () => {
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

    // Bucket 00:00 -> avg 10; 01:00 -> avg 30 (highest); 02:00 -> avg 20.
    await prisma.sensorReading.createMany({
      data: [
        { deviceId: 1, time: new Date("2026-06-15T00:30:00Z"), temperature: 10 },
        { deviceId: 1, time: new Date("2026-06-15T01:30:00Z"), temperature: 30 },
        { deviceId: 1, time: new Date("2026-06-15T02:30:00Z"), temperature: 20 },
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  const agg = { aggregate: { avgTemp: { avg: "temperature" } } } as const;

  it("defaults to bucket ascending", async () => {
    const rows = await prisma.sensorReading.timeBucket({ bucket: "1 hour", range, ...agg });
    expect(rows.map((r: { avgTemp: number }) => r.avgTemp)).toEqual([10, 30, 20]);
  });

  it("orderBy bucket desc + limit returns the latest N buckets, newest first", async () => {
    const rows = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range,
      ...agg,
      orderBy: { bucket: "desc" },
      limit: 2,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].avgTemp).toBe(20); // 02:00 bucket (latest)
    expect(rows[1].avgTemp).toBe(30); // 01:00 bucket
    expect(rows[0].bucket.getTime()).toBeGreaterThan(rows[1].bucket.getTime());
  });

  it("orderBy an aggregate desc + limit returns the top buckets by value", async () => {
    const rows = await prisma.sensorReading.timeBucket({
      bucket: "1 hour",
      range,
      ...agg,
      orderBy: { avgTemp: "desc" },
      limit: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].avgTemp).toBe(30); // the 01:00 bucket has the highest average
  });
});
