// THE reset-safety proof (BUILD_PLAN M5): apply the GENERATED migrations through Prisma's
// engine on a real TimescaleDB, then `migrate reset` twice and confirm the hypertable +
// continuous aggregate + policy are reproduced with zero manual steps and zero errors.
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
    "\n[integration] SKIPPED: Docker is not available. The reset-safety guarantee is NOT verified.\n",
  );
}

async function counts(h: Harness) {
  const [hyper] = await h.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM timescaledb_information.hypertables WHERE hypertable_name = 'SensorReading'",
  );
  const [cagg] = await h.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM timescaledb_information.continuous_aggregates WHERE view_name = 'SensorHourly'",
  );
  const [policy] = await h.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM timescaledb_information.jobs WHERE proc_name = 'policy_refresh_continuous_aggregate'",
  );
  return { hypertables: hyper?.n ?? 0, caggs: cagg?.n ?? 0, policies: policy?.n ?? 0 };
}

describe.skipIf(!DOCKER_OK)("reset-safety (generated migrations)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    // Run OUR generator (via `prisma generate`) to emit the extension + objects migrations
    // and the type registry. This also validates the generator binary end-to-end.
    h.prisma(["generate"]);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it("applies the generated migrations and creates the hypertable + cagg + policy", async () => {
    h.prisma(["migrate", "deploy"]);
    expect(await counts(h)).toEqual({ hypertables: 1, caggs: 1, policies: 1 });
  });

  it("reproduces everything across two `migrate reset` runs (idempotent replay)", async () => {
    h.prisma(["migrate", "reset", "--force"]);
    expect(await counts(h)).toEqual({ hypertables: 1, caggs: 1, policies: 1 });

    // The key assertion: reset again and re-verify — proves idempotent replay.
    h.prisma(["migrate", "reset", "--force"]);
    expect(await counts(h)).toEqual({ hypertables: 1, caggs: 1, policies: 1 });
  });

  it("inserts data and reads it back via timeBucket + cagg findMany + refresh", async () => {
    // Use the real generated client (built by `prisma generate`) + our extension and the
    // generated registry — validates the M4 runtime end-to-end against real TimescaleDB.
    const { PrismaClient } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { registry } = await import(pathToFileURL(join(h.projectDir, "timescale", "index.ts")).href);

    const base = new PrismaClient({ adapter: new PrismaPg({ connectionString: h.databaseUrl }) });
    const prisma = base.$extends(timescaledb(registry));

    try {
      await prisma.sensorReading.createMany({
        data: [
          { time: new Date("2026-06-15T10:05:00Z"), deviceId: 1, temperature: 20 },
          { time: new Date("2026-06-15T10:25:00Z"), deviceId: 1, temperature: 22 },
          { time: new Date("2026-06-15T10:45:00Z"), deviceId: 1, temperature: 24 },
          { time: new Date("2026-06-15T11:10:00Z"), deviceId: 1, temperature: 30 },
          { time: new Date("2026-06-15T10:15:00Z"), deviceId: 2, temperature: 15 },
        ],
      });

      // Ad-hoc time_bucket query on the hypertable model.
      const rows = await prisma.sensorReading.timeBucket({
        bucket: "1 hour",
        range: { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") },
        groupBy: ["deviceId"],
        aggregate: { avgTemp: { avg: "temperature" }, n: { count: "temperature" } },
      });
      const norm = rows
        .map((r: { bucket: Date; deviceId: number; avgTemp: number; n: number }) => ({
          h: r.bucket.toISOString(),
          d: r.deviceId,
          avg: Number(r.avgTemp),
          n: Number(r.n),
        }))
        .sort((a, b) => a.d - b.d || a.h.localeCompare(b.h));
      expect(norm).toEqual([
        { h: "2026-06-15T10:00:00.000Z", d: 1, avg: 22, n: 3 },
        { h: "2026-06-15T11:00:00.000Z", d: 1, avg: 30, n: 1 },
        { h: "2026-06-15T10:00:00.000Z", d: 2, avg: 15, n: 1 },
      ]);

      // where operators: device 1 AND temperature >= 21 (excludes the 20.0 reading).
      const filtered = await prisma.sensorReading.timeBucket({
        bucket: "1 hour",
        range: { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") },
        where: { AND: [{ deviceId: { in: [1] } }, { temperature: { gte: 21 } }] },
        groupBy: ["deviceId"],
        aggregate: { n: { count: "temperature" } },
      });
      expect(
        filtered
          .map((r: { bucket: Date; n: number }) => ({ h: r.bucket.toISOString(), n: Number(r.n) }))
          .sort((a, b) => a.h.localeCompare(b.h)),
      ).toEqual([
        { h: "2026-06-15T10:00:00.000Z", n: 2 }, // 22 + 24 (20 excluded by >= 21)
        { h: "2026-06-15T11:00:00.000Z", n: 1 }, // 30
      ]);

      // Refresh the continuous aggregate, then read it as a normal typed Prisma view.
      await prisma.$timescale.refreshContinuousAggregate("SensorHourly");
      const hourly = await prisma.sensorHourly.findMany({ orderBy: [{ deviceId: "asc" }, { bucket: "asc" }] });
      expect(
        hourly.map((r: { bucket: Date; deviceId: number; avgTemp: number }) => ({
          d: r.deviceId,
          avg: Number(r.avgTemp),
        })),
      ).toEqual([{ d: 1, avg: 22 }, { d: 1, avg: 30 }, { d: 2, avg: 15 }]);
    } finally {
      await base.$disconnect();
    }
  });
});
