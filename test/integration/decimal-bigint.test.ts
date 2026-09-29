// Issue #163: Decimal and BigInt columns as aggregate targets, on real TimescaleDB. sum/avg cast
// to double precision by default (or to text / bigint with `as`), while min/max are not cast, so
// Prisma's raw deserializer hands back a Decimal or a bigint for them. The type tests pin the
// same shapes; this checks what actually arrives.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness, type TestPrismaClient, dockerAvailable } from "./harness.js";
import { timescaledb } from "../../src/client/index.js";

const DOCKER_OK = dockerAvailable("Decimal and BigInt aggregate targets are NOT verified.");

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model Trade {
  time   DateTime @db.Timestamptz(3)
  symbol String
  price  Decimal  @db.Decimal(12, 4)
  volume BigInt

  @@id([symbol, time])
}`;

const INIT_SQL = `CREATE TABLE "Trade" (
  "time" TIMESTAMPTZ NOT NULL,
  "symbol" TEXT NOT NULL,
  "price" DECIMAL(12,4) NOT NULL,
  "volume" BIGINT NOT NULL,
  CONSTRAINT "Trade_pkey" PRIMARY KEY ("symbol","time")
);`;

const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-15T01:00:00Z") };

describe.skipIf(!DOCKER_OK)("Decimal and BigInt aggregate targets (real TimescaleDB)", () => {
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

    await h.query(`INSERT INTO "Trade" ("time", "symbol", "price", "volume") VALUES
      ('2026-06-15T00:10:00Z', 'ABC', 10.2500, 9007199254740993),
      ('2026-06-15T00:20:00Z', 'ABC', 10.7500, 7)`);
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("sum/avg come back as numbers by default and exact with as, min/max in the column's type", async () => {
    const [row] = await prisma.trade.timeBucket({
      bucket: "1 hour",
      range,
      aggregate: {
        total: { sum: "price" },
        exact: { sum: "price", as: "string" },
        avg: { avg: "price" },
        vol: { sum: "volume", as: "bigint" },
        top: { max: "price" },
        most: { max: "volume" },
      },
    });
    expect(row.total).toBe(21);
    expect(row.exact).toBe("21.0000");
    expect(row.avg).toBe(10.5);
    expect(row.vol).toBe(9007199254740993n + 7n); // past 2^53, exact only as a bigint
    // Not cast: a Prisma.Decimal (toFixed is the decimal.js shape) and a bigint.
    expect(typeof row.top.toFixed).toBe("function");
    expect(row.top.toString()).toBe("10.75");
    expect(row.most).toBe(9007199254740993n);
  });

  it("a Decimal in where binds as its exact text", async () => {
    const { Prisma } = await import(pathToFileURL(join(h.projectDir, "client", "client.ts")).href);
    const [row] = await prisma.trade.timeBucket({
      bucket: "1 hour",
      range,
      where: { price: { gte: new Prisma.Decimal("10.5") } },
      aggregate: { n: { count: "symbol" } },
    });
    expect(Number(row.n)).toBe(1);
  });
});
