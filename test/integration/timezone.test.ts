// timezone / offset for timeBucket, end-to-end on real TimescaleDB. Two rows straddling UTC
// midnight bucket into ONE local day under a +2h timezone but TWO buckets under default UTC —
// the DST-aware calendar behaviour. Requires a timestamptz column (@db.Timestamptz).
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
  console.warn("\n[integration] SKIPPED timezone.test.ts: Docker is not available. Not verified.\n");
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model Reading {
  time     DateTime @db.Timestamptz(3)
  deviceId Int
  value    Float

  @@id([deviceId, time])
}`;

const INIT_SQL = `CREATE TABLE "Reading" (
  "time" TIMESTAMPTZ NOT NULL,
  "deviceId" INTEGER NOT NULL,
  "value" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "Reading_pkey" PRIMARY KEY ("deviceId","time")
);`;

const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-17T00:00:00Z") };

describe.skipIf(!DOCKER_OK)("timeBucket timezone / offset (real TimescaleDB)", () => {
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

    // Two rows straddling UTC midnight: 23:30Z (Jun 15) and 00:30Z (Jun 16).
    await prisma.reading.createMany({
      data: [
        { deviceId: 1, time: new Date("2026-06-15T23:30:00Z"), value: 1 },
        { deviceId: 1, time: new Date("2026-06-16T00:30:00Z"), value: 2 },
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("buckets by the given timezone (DST-aware), unlike the default UTC", async () => {
    // Europe/Stockholm is UTC+2 in June, so 23:30Z and 00:30Z are 01:30 & 02:30 local on Jun 16.
    const local = await prisma.reading.timeBucket({
      bucket: "1 day",
      range,
      timezone: "Europe/Stockholm",
      aggregate: { n: { count: "deviceId" } },
    });
    expect(local).toHaveLength(1); // both rows land on the same local (Stockholm) day
    expect(Number(local[0].n)).toBe(2);

    const utc = await prisma.reading.timeBucket({
      bucket: "1 day",
      range,
      aggregate: { n: { count: "deviceId" } },
    });
    expect(utc).toHaveLength(2); // the rows straddle UTC midnight
  });

  it("offset shifts bucket boundaries", async () => {
    // 6h offset -> daily buckets start at 06:00. 23:30Z(15) and 00:30Z(16) both fall in
    // [Jun 15 06:00, Jun 16 06:00) -> a single bucket.
    const shifted = await prisma.reading.timeBucket({
      bucket: "1 day",
      range,
      offset: "6 hours",
      aggregate: { n: { count: "deviceId" } },
    });
    expect(shifted).toHaveLength(1);
    expect(Number(shifted[0].n)).toBe(2);
  });
});
