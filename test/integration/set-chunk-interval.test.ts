// Changing a live hypertable's chunk interval at runtime on real TimescaleDB:
// $timescale.setChunkInterval -> set_partitioning_interval. The default harness hypertable is
// created with chunkInterval "1 day"; we resize it and confirm via timescaledb_information.dimensions.
// Runtime-only feature (no migration emitted), so no migrate-reset assertion is needed.
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
  console.warn("\n[integration] SKIPPED set-chunk-interval.test.ts: Docker is not available. Not verified.\n");
}

/** The hypertable's current time-dimension chunk interval, in seconds (robust to interval display). */
async function chunkIntervalSeconds(h: Harness): Promise<number> {
  const [row] = await h.query<{ s: number }>(
    `SELECT EXTRACT(EPOCH FROM time_interval)::int AS s
       FROM timescaledb_information.dimensions
      WHERE hypertable_name = 'SensorReading' AND column_name = 'time'`,
  );
  return Number(row?.s ?? 0);
}

const DAY = 86_400;
const SIX_HOURS = 21_600;

describe.skipIf(!DOCKER_OK)("set chunk interval (runtime)", () => {
  let h: Harness;
  // deno-lint-ignore no-explicit-any
  let prisma: any;
  let base: { $disconnect(): Promise<void> };

  beforeAll(async () => {
    h = await startHarness(); // default SensorReading hypertable, created with chunkInterval "1 day"
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);

    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);
    base = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    prisma = (base as { $extends: (e: unknown) => unknown }).$extends(timescaledb(registry));
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("changes the time-dimension chunk interval and is idempotent", async () => {
    // Created at "1 day" by the annotation.
    expect(await chunkIntervalSeconds(h)).toBe(DAY);

    await prisma.$timescale.setChunkInterval("SensorReading", "6 hours");
    expect(await chunkIntervalSeconds(h)).toBe(SIX_HOURS);

    // Re-applying the same value is a no-op, not an error.
    await prisma.$timescale.setChunkInterval("SensorReading", "6 hours");
    expect(await chunkIntervalSeconds(h)).toBe(SIX_HOURS);
  });
});
