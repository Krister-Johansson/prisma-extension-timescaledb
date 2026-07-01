// Continuous-aggregate refresh-policy management at runtime, on real TimescaleDB:
// $timescale.removeContinuousAggregatePolicy / addContinuousAggregatePolicy. The default harness
// schema already has a refresh policy from the annotation; verified against timescaledb_information.jobs.
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
  console.warn("\n[integration] SKIPPED cagg-policy.test.ts: Docker is not available. Not verified.\n");
}

async function refreshJobs(h: Harness): Promise<number> {
  const [row] = await h.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM timescaledb_information.jobs WHERE proc_name = 'policy_refresh_continuous_aggregate'",
  );
  return row?.n ?? 0;
}

const policy = { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" } as const;

describe.skipIf(!DOCKER_OK)("continuous-aggregate refresh policy (runtime)", () => {
  let h: Harness;
  let prisma: TestPrismaClient;
  let base: { $disconnect(): Promise<void> };

  beforeAll(async () => {
    h = await startHarness(); // default models: SensorReading hypertable + SensorHourly cagg (with refresh policy)
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

  it("add / remove the cagg refresh policy at runtime", async () => {
    // The generator already added a refresh policy from the annotation.
    expect(await refreshJobs(h)).toBe(1);

    await prisma.$timescale.removeContinuousAggregatePolicy("SensorHourly");
    expect(await refreshJobs(h)).toBe(0);

    await prisma.$timescale.addContinuousAggregatePolicy("SensorHourly", policy);
    expect(await refreshJobs(h)).toBe(1);

    // Idempotent: re-adding the identical policy is a no-op, not an error.
    await prisma.$timescale.addContinuousAggregatePolicy("SensorHourly", policy);
    expect(await refreshJobs(h)).toBe(1);
  });
});
