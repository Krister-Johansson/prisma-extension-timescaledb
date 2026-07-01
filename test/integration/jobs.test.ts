// Background-job control + introspection at runtime, on real TimescaleDB: $timescale.listJobs /
// jobStats / jobErrors / alterJob / runJob / deleteJob. The schema declares a retention policy
// (job -> SensorReading) and a cagg refresh policy (job -> SensorHourly), so we can exercise both
// the model filter (hypertable vs cagg) and the full job lifecycle.
//
// Runtime-only feature (these $timescale methods emit no migration SQL), so — like the other
// runtime $timescale tests (cagg-policy, chunk-helpers, set-chunk-interval) — it uses migrate deploy
// without a migrate-reset assertion. Reset-safety of the underlying retention/cagg refresh policies
// is covered by retention.test.ts / reset-safety.test.ts.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness, type TestPrismaClient } from "./harness.js";
import { timescaledb } from "../../src/client/index.js";
import type { TimescaleJob } from "../../src/client/manage.js";

const DOCKER_OK = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!DOCKER_OK) {
  console.warn("\n[integration] SKIPPED jobs.test.ts: Docker is not available. Not verified.\n");
}

// Default harness columns (time / deviceId / temperature) + a retention policy on the hypertable and
// a refresh policy on the cagg.
const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.retention(dropAfter: "90 days")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupBy
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "temperature")

  @@unique([deviceId, bucket])
}`;

describe.skipIf(!DOCKER_OK)("job control + introspection (runtime)", () => {
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
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  const jobByProc = async (model: string, proc: string): Promise<TimescaleJob | undefined> =>
    (await prisma.$timescale.listJobs(model)).find((j: TimescaleJob) => j.procName === proc);

  it("lists jobs and filters by model (hypertable vs continuous aggregate)", async () => {
    const retention = await jobByProc("SensorReading", "policy_retention");
    const refresh = await jobByProc("SensorHourly", "policy_refresh_continuous_aggregate");
    expect(retention).toBeTruthy();
    expect(retention.hypertableName).toBe("SensorReading");
    expect(retention.scheduled).toBe(true);
    expect(refresh).toBeTruthy();
    expect(refresh.hypertableName).toBe("SensorHourly");

    // The model filter excludes the other relation's jobs and the built-in (relation-less) jobs.
    const onlyRetention = await prisma.$timescale.listJobs("SensorReading");
    expect(onlyRetention.every((j: { hypertableName: string }) => j.hypertableName === "SensorReading")).toBe(true);
  });

  it("alterJob pauses, resumes, and reschedules a policy", async () => {
    const before = await jobByProc("SensorReading", "policy_retention");

    await prisma.$timescale.alterJob(before.jobId, { scheduled: false });
    expect((await jobByProc("SensorReading", "policy_retention")).scheduled).toBe(false);

    await prisma.$timescale.alterJob(before.jobId, { scheduled: true, scheduleInterval: "2 days" });
    const after = await jobByProc("SensorReading", "policy_retention");
    expect(after.scheduled).toBe(true);
    expect(after.scheduleInterval).toBe("2 days");
  });

  it("runJob runs a job synchronously and jobStats returns bigint counts", async () => {
    const retention = await jobByProc("SensorReading", "policy_retention");
    // Retention on recent/empty data is a safe no-op; it must not throw.
    await prisma.$timescale.runJob(retention.jobId);

    const [stats] = await prisma.$timescale.jobStats("SensorReading");
    expect(stats.jobId).toBe(retention.jobId);
    expect(typeof stats.totalRuns).toBe("bigint");
    // jobErrors is queryable (no failures expected) and returns an array.
    expect(Array.isArray(await prisma.$timescale.jobErrors("SensorReading"))).toBe(true);
  });

  it("deleteJob removes a job", async () => {
    const retention = await jobByProc("SensorReading", "policy_retention");
    await prisma.$timescale.deleteJob(retention.jobId);
    expect(await jobByProc("SensorReading", "policy_retention")).toBeUndefined();
  });
});
