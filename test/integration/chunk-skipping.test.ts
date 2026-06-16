// Chunk skipping end-to-end on real TimescaleDB. Two angles, one container:
//   1. Generated + reset-safe: the `chunkSkipping` annotation emits a DO block that turns the
//      `timescaledb.enable_chunk_skipping` GUC on and calls enable_chunk_skipping(...), surviving
//      `migrate reset` (idempotent replay).
//   2. Runtime: $timescale.disableChunkSkipping / enableChunkSkipping toggle the column, idempotently.
// Verified against the internal catalog `_timescaledb_catalog.chunk_column_stats` (there is no public
// timescaledb_information view for chunk skipping). The GUC requirement and the "compressed chunks
// only" caveat are exercised implicitly: the enable call only succeeds because we set the GUC.
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
  console.warn("\n[integration] SKIPPED chunk-skipping.test.ts: Docker is not available. Not verified.\n");
}

// eventId is a secondary (non-partitioning, non-segmentBy) column — the correct target for chunk
// skipping. segmentBy is deviceId, so the generator guard does not trip.
const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day", chunkSkipping: "eventId")
/// @timescale.compression(after: "7 days", segmentBy: "deviceId")
model SensorReading {
  time        DateTime
  deviceId    Int
  eventId     BigInt
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}`;

const INIT_SQL = `-- CreateTable
CREATE TABLE "SensorReading" (
    "time" TIMESTAMP(3) NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "eventId" BIGINT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("deviceId","time")
);

-- CreateIndex
CREATE INDEX "SensorReading_deviceId_time_idx" ON "SensorReading"("deviceId", "time");
`;

/** Count the hypertable-level chunk-skipping registrations for SensorReading.eventId. */
async function skippingColumns(h: Harness): Promise<number> {
  const [row] = await h.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM _timescaledb_catalog.chunk_column_stats s
       JOIN _timescaledb_catalog.hypertable h ON h.id = s.hypertable_id
      WHERE h.table_name = 'SensorReading' AND s.column_name = 'eventId'`,
  );
  return row?.n ?? 0;
}

describe.skipIf(!DOCKER_OK)("chunk skipping (generated + runtime)", () => {
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
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("disables / re-enables chunk skipping at runtime ($timescale), idempotently", async () => {
    // The generator already enabled eventId from the annotation.
    expect(await skippingColumns(h)).toBe(1);

    await prisma.$timescale.disableChunkSkipping("SensorReading", "eventId");
    expect(await skippingColumns(h)).toBe(0);
    // Idempotent: re-disabling a not-enabled column is a no-op, not an error.
    await prisma.$timescale.disableChunkSkipping("SensorReading", "eventId");
    expect(await skippingColumns(h)).toBe(0);

    await prisma.$timescale.enableChunkSkipping("SensorReading", "eventId");
    expect(await skippingColumns(h)).toBe(1);
    // Idempotent: re-enabling is a no-op.
    await prisma.$timescale.enableChunkSkipping("SensorReading", "eventId");
    expect(await skippingColumns(h)).toBe(1);
  });

  it("emits a reset-safe enable_chunk_skipping from the annotation", async () => {
    // Reproduced across `migrate reset` (idempotent replay, zero manual steps) — run twice.
    h.prisma(["migrate", "reset", "--force"]);
    expect(await skippingColumns(h)).toBe(1);
    h.prisma(["migrate", "reset", "--force"]);
    expect(await skippingColumns(h)).toBe(1);
  });
});
