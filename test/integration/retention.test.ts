// Retention policies end-to-end on a real TimescaleDB: the generator emits a reset-safe
// add_retention_policy from @timescale.retention, and the $timescale runtime helpers
// add/remove a policy. Verified against timescaledb_information.jobs.
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
  console.warn(
    "\n[integration] SKIPPED retention.test.ts: Docker is not available. Retention policies are NOT verified.\n",
  );
}

// Hypertable-only schema with a retention policy (matches the harness default CREATE TABLE).
const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.retention(dropAfter: "30 days")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}`;

async function retentionJobs(h: Harness): Promise<number> {
  const [row] = await h.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM timescaledb_information.jobs WHERE proc_name = 'policy_retention'",
  );
  return row?.n ?? 0;
}

describe.skipIf(!DOCKER_OK)("retention policies (generated + runtime)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ models: MODELS });
    h.prisma(["generate"]);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it("emits a reset-safe retention policy from @timescale.retention", async () => {
    h.prisma(["migrate", "deploy"]);
    expect(await retentionJobs(h)).toBe(1);

    // Reproduced across `migrate reset` (idempotent replay, zero manual steps).
    h.prisma(["migrate", "reset", "--force"]);
    expect(await retentionJobs(h)).toBe(1);
  });

  it("$timescale.addRetentionPolicy / removeRetentionPolicy operate at runtime", async () => {
    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);

    const base = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    const prisma = base.$extends(timescaledb(registry));
    try {
      await prisma.$timescale.removeRetentionPolicy("SensorReading");
      expect(await retentionJobs(h)).toBe(0);

      await prisma.$timescale.addRetentionPolicy("SensorReading", { dropAfter: "7 days" });
      expect(await retentionJobs(h)).toBe(1);

      // Idempotent: re-adding the identical policy is a no-op, not an error.
      await prisma.$timescale.addRetentionPolicy("SensorReading", { dropAfter: "7 days" });
      expect(await retentionJobs(h)).toBe(1);
    } finally {
      await base.$disconnect();
    }
  });
});
