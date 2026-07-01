// A hypertable with a physical column named "bucket", end-to-end on real TimescaleDB. Postgres
// resolves an unqualified GROUP BY name to an INPUT column before an output alias, so grouping by
// the "bucket" alias used to fail every timeBucket() on such a model with "column ... must appear
// in the GROUP BY clause" — and the same alias capture broke the cagg CREATE at migrate deploy.
// Proves both builders group by the expression instead.
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
  console.warn(
    "\n[integration] SKIPPED bucket-column.test.ts: Docker is not available. bucket-column collision is NOT verified.\n",
  );
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model Reading {
  time   DateTime
  id     Int
  bucket Int      // physical column named like the reserved output alias
  value  Float

  @@id([id, time])
}

/// @timescale.continuousAggregate(source: "Reading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view ReadingHourly {
  bucket   DateTime /// @timescale.bucket
  avgValue Float    /// @timescale.aggregate(fn: "avg", column: "value")

  @@unique([bucket])
}`;

const INIT_SQL = `CREATE TABLE "Reading" (
    "time" TIMESTAMP(3) NOT NULL,
    "id" INTEGER NOT NULL,
    "bucket" INTEGER NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Reading_pkey" PRIMARY KEY ("id","time")
);`;

describe.skipIf(!DOCKER_OK)("physical `bucket` column (real TimescaleDB)", () => {
  let h: Harness;
  let prisma: TestPrismaClient;
  let base: { $disconnect(): Promise<void> };

  beforeAll(async () => {
    // migrate deploy already exercises the cagg fix: its CREATE MATERIALIZED VIEW groups by the
    // time_bucket expression over a source table that has a physical "bucket" column.
    h = await startHarness({ models: MODELS, initSql: INIT_SQL });
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);

    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);
    base = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    prisma = (base as { $extends: (e: unknown) => unknown }).$extends(timescaledb(registry));

    await prisma.reading.createMany({
      data: [
        { time: new Date("2026-06-15T10:05:00Z"), id: 1, bucket: 7, value: 10 },
        { time: new Date("2026-06-15T10:25:00Z"), id: 2, bucket: 7, value: 20 },
        { time: new Date("2026-06-15T10:45:00Z"), id: 3, bucket: 9, value: 30 },
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") };

  it("timeBucket works on a model with a physical `bucket` column", async () => {
    const rows = await prisma.reading.timeBucket({
      bucket: "1 hour",
      range,
      aggregate: { avgValue: { avg: "value" } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].avgValue).toBe(20);
  });

  it("grouping BY the physical `bucket` column throws the clear reserved-name error", async () => {
    // The output column "bucket" is claimed by the time_bucket expression, so grouping by a
    // same-named field must be rejected up front rather than silently clobbering the result key.
    await expect(
      prisma.reading.timeBucket({
        bucket: "1 hour",
        range,
        groupBy: ["bucket"],
        aggregate: { avgValue: { avg: "value" } },
      }),
    ).rejects.toThrow(/reserved "bucket"/);
  });

  it("the cagg over the colliding source refreshes and reads back", async () => {
    await prisma.$timescale.refreshContinuousAggregate("ReadingHourly");
    const rows = await prisma.readingHourly.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].avgValue).toBe(20);
  });
});
