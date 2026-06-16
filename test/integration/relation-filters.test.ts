// Relation filters in timeBucket where, end-to-end on real TimescaleDB. The generator extracts
// relation metadata (to-one `device`, composite-key to-many `tags`) into the registry, and the
// runtime builds EXISTS subqueries. Counts mirror the research probe's Prisma results.
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
    "\n[integration] SKIPPED relation-filters.test.ts: Docker is not available. Relation filters are NOT verified.\n",
  );
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model Reading {
  time     DateTime
  id       Int
  deviceId Int?
  device   Device? @relation(fields: [deviceId], references: [id])
  tags     Tag[]

  @@id([id, time])
}
model Device {
  id       Int       @id
  active   Boolean
  readings Reading[]
}
model Tag {
  id          Int      @id
  label       String
  readingId   Int
  readingTime DateTime
  reading     Reading  @relation(fields: [readingId, readingTime], references: [id, time])
}`;

// Plain columns (no DB-level FKs — the relations are enforced logically via the EXISTS join,
// which keeps the hypertable conversion simple).
const INIT_SQL = `CREATE TABLE "Device" ("id" INTEGER PRIMARY KEY, "active" BOOLEAN NOT NULL);
CREATE TABLE "Reading" ("time" TIMESTAMP(3) NOT NULL, "id" INTEGER NOT NULL, "deviceId" INTEGER,
  CONSTRAINT "Reading_pkey" PRIMARY KEY ("id","time"));
CREATE TABLE "Tag" ("id" INTEGER PRIMARY KEY, "label" TEXT NOT NULL, "readingId" INTEGER NOT NULL,
  "readingTime" TIMESTAMP(3) NOT NULL);`;

const t = (m: number) => new Date(`2026-06-15T10:${String(m).padStart(2, "0")}:00Z`);

describe.skipIf(!DOCKER_OK)("timeBucket relation filters (real TimescaleDB)", () => {
  let h: Harness;
  // deno-lint-ignore no-explicit-any
  let prisma: any;
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

    await prisma.device.createMany({ data: [{ id: 1, active: true }, { id: 2, active: false }] });
    // R1 active+[prod,dev]; R2 inactive+[prod]; R3 no-device+[]; R4 active+[dev]
    await prisma.reading.createMany({
      data: [
        { id: 1, time: t(5), deviceId: 1 },
        { id: 2, time: t(15), deviceId: 2 },
        { id: 3, time: t(25), deviceId: null },
        { id: 4, time: t(35), deviceId: 1 },
      ],
    });
    await prisma.tag.createMany({
      data: [
        { id: 1, label: "prod", readingId: 1, readingTime: t(5) },
        { id: 2, label: "dev", readingId: 1, readingTime: t(5) },
        { id: 3, label: "prod", readingId: 2, readingTime: t(15) },
        { id: 4, label: "dev", readingId: 4, readingTime: t(35) },
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") };
  const count = async (where?: unknown): Promise<number> => {
    const rows = await prisma.reading.timeBucket({ bucket: "1 hour", range, where, aggregate: { n: { count: "id" } } });
    return rows.reduce((s: number, r: { n: number }) => s + Number(r.n), 0);
  };
  // The gold standard: the same where through Prisma's own findMany (time-bounded to match the
  // timeBucket range), so results are checked against Prisma rather than hand-computed counts.
  const expected = async (where: object): Promise<number> =>
    (
      await prisma.reading.findMany({
        // AND (not spread) so a case carrying its own `time` can never override the range guardrail.
        where: { AND: [{ time: { gte: range.start, lt: range.end } }, where] },
        select: { id: true },
      })
    ).length;

  it("no filter counts all rows", async () => {
    expect(await count()).toBe(4);
  });

  it("to-one is / isNot / null", async () => {
    expect(await count({ device: { is: { active: true } } })).toBe(2); // R1, R4
    expect(await count({ device: { isNot: { active: true } } })).toBe(2); // R2 + R3 (no device)
    expect(await count({ device: { is: null } })).toBe(1); // R3
    expect(await count({ device: { isNot: null } })).toBe(3); // R1, R2, R4
    expect(await count({ device: { active: true } })).toBe(2); // shorthand == is
  });

  it("to-many some / none / every (composite join, vacuous truth)", async () => {
    expect(await count({ tags: { some: { label: "prod" } } })).toBe(2); // R1, R2
    expect(await count({ tags: { none: { label: "prod" } } })).toBe(2); // R3 (no tags), R4
    expect(await count({ tags: { every: { label: "prod" } } })).toBe(2); // R2, R3 (vacuous)
  });

  it("composes with scalar filters and AND/OR", async () => {
    expect(await count({ AND: [{ device: { is: { active: true } } }, { tags: { some: { label: "dev" } } }] })).toBe(2); // R1, R4
    expect(await count({ deviceId: { not: null }, tags: { none: { label: "dev" } } })).toBe(1); // R2 (has device, no dev tag)
  });

  it("nests relation filters THROUGH other relations, matching Prisma findMany exactly", async () => {
    // Each case crosses ≥2 relation levels; the runtime builds correlated, nested EXISTS. Comparing
    // to Prisma's own findMany (same time-bounded where) verifies the semantics rather than guessing.
    const cases: object[] = [
      { device: { is: { readings: { some: { id: 1 } } } } }, // Reading→Device→readings (2 levels)
      { device: { is: { readings: { some: { tags: { some: { label: "dev" } } } } } } }, // →readings→tags (3)
      { device: { is: { readings: { none: { tags: { some: { label: "dev" } } } } } } }, // nested `none`
      { tags: { some: { reading: { is: { device: { is: { active: true } } } } } } }, // Reading→Tag→reading→Device (3)
      { device: { isNot: { readings: { every: { tags: { some: { label: "prod" } } } } } } }, // nested `every` under isNot
    ];
    for (const where of cases) {
      expect(await count(where)).toBe(await expected(where));
    }
  });
});
