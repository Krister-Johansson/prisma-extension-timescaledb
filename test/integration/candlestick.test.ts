// Toolkit candlestick_agg in timeBucket, end-to-end on real TimescaleDB (the `-ha` image carries
// timescaledb_toolkit). One op returns an OHLC + vwap JS object per bucket (jsonb_build_object over
// candlestick_agg(time, price, volume)). Three trades make the values predictable.
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
  console.warn("\n[integration] SKIPPED candlestick.test.ts: Docker is not available. Not verified.\n");
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model Trade {
  time   DateTime
  symbol Int
  price  Float
  volume Float

  @@id([symbol, time])
  @@index([symbol, time])
}`;

const INIT_SQL = `-- CreateTable
CREATE TABLE "Trade" (
    "time" TIMESTAMP(3) NOT NULL,
    "symbol" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "volume" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("symbol","time")
);

-- CreateIndex
CREATE INDEX "Trade_symbol_time_idx" ON "Trade"("symbol", "time");
`;

const range = { start: new Date("2026-06-15T00:00:00Z"), end: new Date("2026-06-15T01:00:00Z") };

describe.skipIf(!DOCKER_OK)("timeBucket candlestick / OHLC (real TimescaleDB Toolkit)", () => {
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

    // Three trades within one hour: prices 10 → 20 → 5, volumes 100 / 200 / 50.
    await prisma.trade.createMany({
      data: [
        { symbol: 1, time: new Date("2026-06-15T00:00:00Z"), price: 10, volume: 100 },
        { symbol: 1, time: new Date("2026-06-15T00:30:00Z"), price: 20, volume: 200 },
        { symbol: 1, time: new Date("2026-06-15T00:45:00Z"), price: 5, volume: 50 },
      ],
    });
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("returns an OHLC + vwap object per bucket", async () => {
    const [row] = await prisma.trade.timeBucket({
      bucket: "1 hour",
      range,
      aggregate: { candle: { candlestick: "price", volume: "volume" } },
    });
    // open = first (10), high = 20, low = 5, close = last (5),
    // vwap = (10*100 + 20*200 + 5*50) / (100+200+50) = 5250/350 = 15.
    expect(row.candle).toEqual({ open: 10, high: 20, low: 5, close: 5, vwap: 15 });
  });
});
