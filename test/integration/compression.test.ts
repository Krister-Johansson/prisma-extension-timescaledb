// Columnstore-compression policies end-to-end on a real TimescaleDB: the generator emits a
// reset-safe `enable_columnstore` + `add_columnstore_policy` from @timescale.compression, and the
// $timescale runtime helpers add/remove a policy. Verified against timescaledb_information.jobs and
// hypertable_columnstore_settings. Requires TimescaleDB >= 2.18 (the columnstore API).
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
    "\n[integration] SKIPPED compression.test.ts: Docker is not available. Compression policies are NOT verified.\n",
  );
}

// Hypertable with a columnstore-compression policy (matches the harness default CREATE TABLE).
const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.compression(after: "7 days", segmentBy: "deviceId", orderBy: "time DESC")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}`;

async function compressionJobs(h: Harness): Promise<number> {
  const [row] = await h.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'",
  );
  return row?.n ?? 0;
}

async function columnstoreSettings(h: Harness): Promise<{ segmentby: string | null; orderby: string | null } | undefined> {
  const rows = await h.query<{ segmentby: string | null; orderby: string | null }>(
    "SELECT segmentby, orderby FROM timescaledb_information.hypertable_columnstore_settings WHERE hypertable::text LIKE '%SensorReading%'",
  );
  return rows[0];
}

describe.skipIf(!DOCKER_OK)("compression policies (generated + runtime)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ models: MODELS });
    h.prisma(["generate"]);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it("emits a reset-safe compression policy + columnstore settings from @timescale.compression", async () => {
    h.prisma(["migrate", "deploy"]);
    expect(await compressionJobs(h)).toBe(1);
    const settings = await columnstoreSettings(h);
    expect(settings?.segmentby).toBe("deviceId");
    expect(settings?.orderby).toContain(`"time"`);
    expect(settings?.orderby).toContain("DESC");

    // Reproduced across `migrate reset` (idempotent replay, zero manual steps) — run twice.
    h.prisma(["migrate", "reset", "--force"]);
    expect(await compressionJobs(h)).toBe(1);
    h.prisma(["migrate", "reset", "--force"]);
    expect(await compressionJobs(h)).toBe(1);
  });

  it("$timescale.addCompressionPolicy / removeCompressionPolicy operate at runtime", async () => {
    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);

    const base = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    const prisma = base.$extends(timescaledb(registry));
    try {
      await prisma.$timescale.removeCompressionPolicy("SensorReading");
      expect(await compressionJobs(h)).toBe(0);

      await prisma.$timescale.addCompressionPolicy("SensorReading", {
        after: "7 days",
        segmentBy: "deviceId",
        orderBy: "time DESC",
      });
      expect(await compressionJobs(h)).toBe(1);

      // Idempotent: re-adding the identical policy is a no-op, not an error.
      await prisma.$timescale.addCompressionPolicy("SensorReading", {
        after: "7 days",
        segmentBy: "deviceId",
        orderBy: "time DESC",
      });
      expect(await compressionJobs(h)).toBe(1);
    } finally {
      await base.$disconnect();
    }
  });
});
