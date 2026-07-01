// mode: "insensitive" in timeBucket where, end-to-end on real TimescaleDB. Every case asserts
// parity with Prisma's own engine (findMany count on the same filter), proving the LOWER(...)
// translation matches what Prisma emits for insensitive equality, lists, comparisons, and
// negation — including NULL exclusion.
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
    "\n[integration] SKIPPED where-insensitive.test.ts: Docker is not available. Insensitive mode is NOT verified.\n",
  );
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model Reading {
  time  DateTime
  id    Int
  label String?

  @@id([id, time])
}`;

const INIT_SQL = `CREATE TABLE "Reading" (
    "time" TIMESTAMP(3) NOT NULL,
    "id" INTEGER NOT NULL,
    "label" TEXT,

    CONSTRAINT "Reading_pkey" PRIMARY KEY ("id","time")
);`;

describe.skipIf(!DOCKER_OK)("timeBucket mode: insensitive (real TimescaleDB)", () => {
  let h: Harness;
  let prisma: TestPrismaClient;
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

    await prisma.reading.createMany({
      data: [
        { time: new Date("2026-06-15T10:05:00Z"), id: 1, label: "FOO" },
        { time: new Date("2026-06-15T10:15:00Z"), id: 2, label: "foo" },
        { time: new Date("2026-06-15T10:25:00Z"), id: 3, label: "Bar" },
        { time: new Date("2026-06-15T10:35:00Z"), id: 4, label: null }, // NULL label
        { time: new Date("2026-06-15T10:45:00Z"), id: 5, label: "10%" }, // literal LIKE wildcard
        { time: new Date("2026-06-15T10:55:00Z"), id: 6, label: "10x" }, // ILIKE-wildcard bait for "10%"
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-16T00:00:00Z") };
  const count = async (where?: unknown): Promise<number> => {
    const [row] = await prisma.reading.timeBucket({ bucket: "1 hour", range, where, aggregate: { n: { count: "id" } } });
    return Number(row?.n ?? 0);
  };
  const parity = async (where: unknown, expected: number): Promise<void> => {
    expect(await count(where)).toBe(expected);
    expect(await count(where)).toBe(await prisma.reading.count({ where }));
  };

  it("equals matches across case", async () => {
    await parity({ label: { equals: "foo", mode: "insensitive" } }, 2); // FOO + foo
  });

  it("in / notIn lower every list value; notIn excludes NULL", async () => {
    await parity({ label: { in: ["FOO", "bar"], mode: "insensitive" } }, 3); // FOO, foo, Bar
    await parity({ label: { notIn: ["foo"], mode: "insensitive" } }, 3); // Bar, 10%, 10x; NULL excluded
  });

  it("scalar not negates case-insensitively and excludes NULL", async () => {
    await parity({ label: { not: "FOO", mode: "insensitive" } }, 3); // Bar, 10%, 10x
  });

  it("comparisons order case-insensitively (parity with Prisma's engine)", async () => {
    await parity({ label: { gt: "BZZ", mode: "insensitive" } }, 2); // foo/FOO > bzz; bar/10% /10x are not
  });

  it("outer mode propagates into a nested not", async () => {
    await parity({ label: { not: { equals: "foo" }, mode: "insensitive" } }, 3); // Bar, 10%, 10x
  });

  it("insensitive equals treats % and _ literally (deliberate divergence from Prisma's unescaped ILIKE)", async () => {
    // "10%" matches ONLY the literal "10%" row here. Prisma's engine compiles insensitive equals
    // to an unescaped ILIKE, so its "10%" also pattern-matches "10x" (prisma/prisma#19506) — a
    // documented wart we intentionally do NOT reproduce. Both behaviors are pinned: if the Prisma
    // assertion below ever drops to 1, the upstream bug is fixed and this can fold into parity().
    const where = { label: { equals: "10%", mode: "insensitive" } };
    expect(await count(where)).toBe(1); // literal: just the "10%" row
    expect(await prisma.reading.count({ where })).toBe(2); // Prisma's ILIKE also catches "10x"
  });
});
