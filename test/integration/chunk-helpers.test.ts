// $timescale chunk + size helpers, end-to-end on real TimescaleDB: drop_chunks (on-demand
// retention) plus the size / row-count / compression-stats introspection. Sizes come back as
// exact JS bigints. Verified against a 3-chunk hypertable (one chunk per day).
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
  console.warn("\n[integration] SKIPPED chunk-helpers.test.ts: Docker is not available. Not verified.\n");
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
}`;

describe.skipIf(!DOCKER_OK)("$timescale chunk + size helpers (real TimescaleDB)", () => {
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

    // 3 rows, each in its own daily chunk, positioned relative to NOW so an interval-based drop is
    // deterministic regardless of the wall clock: ~20, ~10 and ~2 days ago.
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
    await prisma.sensorReading.createMany({
      data: [
        { deviceId: 1, time: at(20), temperature: 1 },
        { deviceId: 1, time: at(10), temperature: 2 },
        { deviceId: 1, time: at(2), temperature: 3 },
      ],
    });
    await h.query(`ANALYZE "SensorReading"`); // so approximate_row_count has planner stats
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("reports total / detailed size and an approximate row count as bigints", async () => {
    const size = await prisma.$timescale.hypertableSize("SensorReading");
    expect(typeof size).toBe("bigint");
    expect(size).toBeGreaterThan(0n);

    const detailed = await prisma.$timescale.hypertableDetailedSize("SensorReading");
    expect(typeof detailed.totalBytes).toBe("bigint");
    expect(detailed.totalBytes).toBeGreaterThan(0n);
    expect(detailed.totalBytes).toBe(detailed.tableBytes + detailed.indexBytes + detailed.toastBytes);

    const rows = await prisma.$timescale.approximateRowCount("SensorReading");
    expect(typeof rows).toBe("bigint");
    expect(rows).toBe(3n);
  });

  it("dropChunks drops old chunks on demand and returns their names", async () => {
    const dropped = await prisma.$timescale.dropChunks("SensorReading", { olderThan: "15 days" });
    expect(dropped).toHaveLength(1); // only the ~20-days-ago chunk is entirely older than 15 days
    expect(dropped.every((c: string) => c.includes("_hyper_"))).toBe(true);

    const [{ n }] = await h.query<{ n: number }>(`SELECT count(*)::int AS n FROM "SensorReading"`);
    expect(Number(n)).toBe(2); // the ~10- and ~2-days-ago rows remain
  });

  it("compressionStats reads catalog stats once columnstore is enabled", async () => {
    await prisma.$timescale.addCompressionPolicy("SensorReading", { after: "7 days" });
    const stats = await prisma.$timescale.compressionStats("SensorReading");
    expect(typeof stats.totalChunks).toBe("bigint");
    expect(stats.compressedChunks).toBe(0n); // policy hasn't run yet — nothing compressed
  });
});
