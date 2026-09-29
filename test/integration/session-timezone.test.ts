// Issue #163: a bound Date reaches Postgres as a zone-less UTC wall clock (that is how the pg
// adapter formats it), and Postgres reads a zone-less literal into timestamptz in the SESSION
// time zone. With `TimeZone = 'Europe/Stockholm'` every range bound and where Date landed two
// hours off, and `alter_job(next_start => ...)` scheduled two hours early. The package now binds
// Dates as ISO strings with an explicit Z, so the instants it sends are exact whatever the
// session zone. This file sets a non-UTC zone on the database before the client connects;
// `timezone.test.ts` runs under the container's default UTC and cannot see the shift.
//
// What the package cannot fix: @prisma/adapter-pg also rewrites the offset of every timestamptz
// it READS to +00:00, so under a non-UTC session Prisma hands back shifted Dates (its own
// findMany included). The read-back assertions below therefore go through the pg driver, which
// parses the offset. The README tells users to keep the session in UTC.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness, type TestPrismaClient, dockerAvailable } from "./harness.js";
import { timescaledb } from "../../src/client/index.js";

const DOCKER_OK = dockerAvailable("Date binding under a non-UTC session time zone is NOT verified.");

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.retention(dropAfter: "10000 days")
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

describe.skipIf(!DOCKER_OK)("Date parameters under a non-UTC session time zone (real TimescaleDB)", () => {
  let h: Harness;
  let prisma: TestPrismaClient;
  let base: { $disconnect(): Promise<void> };

  beforeAll(async () => {
    h = await startHarness({ models: MODELS, initSql: INIT_SQL });
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);

    // Every NEW session on this database starts in Stockholm time (UTC+2 in June).
    const [{ db }] = await h.query<{ db: string }>("SELECT current_database() AS db");
    await h.query(`ALTER DATABASE "${db}" SET timezone TO 'Europe/Stockholm'`);
    // Rows inserted with explicit instants, outside the adapter, so the data itself is exact.
    await h.query(`INSERT INTO "Reading" ("time", "deviceId", "value") VALUES
      ('2026-06-15T23:30:00Z', 1, 1), ('2026-06-16T00:30:00Z', 1, 2), ('2026-06-16T05:00:00Z', 2, 4), ('2026-06-16T12:00:00Z', 2, 3)`);

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

  it("the session really is in a non-UTC zone", async () => {
    const [row] = await h.query<{ TimeZone: string }>("SHOW timezone");
    expect(row?.TimeZone).toBe("Europe/Stockholm");
  });

  it("range bounds mean the instants the Dates hold, not the session's wall clock", async () => {
    // Midnight UTC on Jun 16 to midnight UTC on Jun 17. Under the old binding the start reached
    // Postgres as '2026-06-16 00:00:00', read as Stockholm time, i.e. 22:00Z the day before, and
    // the 23:30Z row leaked into the window.
    const rows = await prisma.reading.timeBucket({
      bucket: "1 day",
      range: { start: new Date("2026-06-16T00:00:00Z"), end: new Date("2026-06-17T00:00:00Z") },
      aggregate: { n: { count: "deviceId" } },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].n)).toBe(3);
  });

  it("a Date in where means its instant too", async () => {
    // Under the old binding 06:00Z reached Postgres as 06:00 Stockholm, i.e. 04:00Z, and the
    // 05:00Z row leaked in.
    const rows = await prisma.reading.timeBucket({
      bucket: "1 day",
      range: { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-17T00:00:00Z") },
      where: { time: { gte: new Date("2026-06-16T06:00:00Z") } },
      aggregate: { n: { count: "deviceId" } },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].n)).toBe(1); // only the 12:00Z row
  });

  it("alterJob's nextStart lands at the given instant", async () => {
    const ts = prisma.$timescale();
    const [job] = await ts.listJobs("Reading");
    expect(job?.procName).toBe("policy_retention");
    const next = new Date("2030-01-01T12:00:00.000Z");
    await ts.alterJob(job!.jobId, { nextStart: next });
    // Read through pg, which keeps the offset: the job is scheduled at the instant given, not an
    // hour early (Stockholm is UTC+1 in January).
    const [after] = await h.query<{ next_start: Date }>(
      "SELECT next_start FROM timescaledb_information.jobs WHERE job_id = $1",
      [job!.jobId],
    );
    expect(after?.next_start.toISOString()).toBe(next.toISOString());
  });
});
