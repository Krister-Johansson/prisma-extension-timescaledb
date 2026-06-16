// Hash space partitioning end-to-end on real TimescaleDB: the generator emits a reset-safe
// add_dimension(by_hash(...)) from partitionColumn / partitions, giving the hypertable a second
// (space) dimension. Verified against timescaledb_information.dimensions, including migrate reset.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./harness.js";

const DOCKER_OK = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!DOCKER_OK) {
  console.warn("\n[integration] SKIPPED space-partition.test.ts: Docker is not available. Not verified.\n");
}

// deviceId is in the @@id, so it's eligible as a partitioning column. Matches the harness default
// CREATE TABLE (time / deviceId / temperature).
const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day", partitionColumn: "deviceId", partitions: 4)
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}`;

async function spacePartitions(h: Harness): Promise<number> {
  const [row] = await h.query<{ n: number | null }>(
    "SELECT num_partitions::int AS n FROM timescaledb_information.dimensions WHERE hypertable_name = 'SensorReading' AND column_name = 'deviceId'",
  );
  return row?.n ?? 0;
}

describe.skipIf(!DOCKER_OK)("space partitioning (generated, reset-safe)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ models: MODELS });
    h.prisma(["generate"]);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it("emits a reset-safe hash space dimension from partitionColumn / partitions", async () => {
    h.prisma(["migrate", "deploy"]);
    expect(await spacePartitions(h)).toBe(4);

    // Reproduced across `migrate reset` (idempotent replay, zero manual steps) — run twice.
    h.prisma(["migrate", "reset", "--force"]);
    expect(await spacePartitions(h)).toBe(4);
    h.prisma(["migrate", "reset", "--force"]);
    expect(await spacePartitions(h)).toBe(4);
  });
});
