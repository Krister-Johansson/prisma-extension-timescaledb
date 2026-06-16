// Nested `not: { ... }` in timeBucket where, end-to-end on real TimescaleDB. Proves the SQL
// executes and that negation excludes NULL rows — matching Prisma's findMany (verified by the
// research probe). Uses a nullable column so the NULL-exclusion is observable.
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
    "\n[integration] SKIPPED where-not.test.ts: Docker is not available. Nested not is NOT verified.\n",
  );
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model Reading {
  time   DateTime
  id     Int
  device Int?

  @@id([id, time])
}`;

const INIT_SQL = `CREATE TABLE "Reading" (
    "time" TIMESTAMP(3) NOT NULL,
    "id" INTEGER NOT NULL,
    "device" INTEGER,

    CONSTRAINT "Reading_pkey" PRIMARY KEY ("id","time")
);`;

describe.skipIf(!DOCKER_OK)("timeBucket nested not (real TimescaleDB)", () => {
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

    await prisma.reading.createMany({
      data: [
        { time: new Date("2026-06-15T10:05:00Z"), id: 1, device: 1 },
        { time: new Date("2026-06-15T10:15:00Z"), id: 2, device: 1 },
        { time: new Date("2026-06-15T10:25:00Z"), id: 3, device: 2 },
        { time: new Date("2026-06-15T10:35:00Z"), id: 4, device: null }, // NULL device
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

  it("counts all rows with no filter (control)", async () => {
    expect(await count()).toBe(4);
  });

  it("not: { in } negates and excludes NULL", async () => {
    // device <> 1 → only device=2 (id 3); device=1 rows and the NULL row are excluded.
    expect(await count({ device: { not: { in: [1] } } })).toBe(1);
  });

  it("not: { gte } negates the comparison and excludes NULL", async () => {
    // NOT(device >= 2) → device < 2 → device=1 (ids 1,2); device=2 and the NULL row excluded.
    expect(await count({ device: { not: { gte: 2 } } })).toBe(2);
  });
});
