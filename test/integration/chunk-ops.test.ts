// On-demand chunk operations at runtime, on real TimescaleDB: $timescale.showChunks /
// compressChunk / decompressChunk. The hypertable enables the columnstore (@timescale.compression)
// so compress_chunk works; we insert two days' worth of data to get two chunks.
//
// Runtime-only feature (these $timescale methods emit no migration SQL), so — like the other runtime
// $timescale tests — it uses migrate deploy without a migrate-reset assertion.
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
  console.warn("\n[integration] SKIPPED chunk-ops.test.ts: Docker is not available. Not verified.\n");
}

const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.compression(after: "7 days", segmentBy: "deviceId")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}`;

/** Set of chunk full-names (schema.name) that are currently compressed, for SensorReading. */
async function compressedChunks(h: Harness): Promise<Set<string>> {
  const rows = await h.query<{ name: string; compressed: boolean }>(
    `SELECT (chunk_schema || '.' || chunk_name) AS name, is_compressed AS compressed
       FROM timescaledb_information.chunks WHERE hypertable_name = 'SensorReading'`,
  );
  return new Set(rows.filter((r) => r.compressed).map((r) => r.name));
}

describe.skipIf(!DOCKER_OK)("on-demand chunk operations (runtime)", () => {
  let h: Harness;
  // deno-lint-ignore no-explicit-any
  let prisma: any;
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

    // Two rows a month apart -> two daily chunks.
    await h.query(
      `INSERT INTO "SensorReading" ("time","deviceId","temperature") VALUES ('2026-01-01 00:00:00',1,1.0),('2026-02-01 00:00:00',2,2.0)`,
    );
  });

  afterAll(async () => {
    await base?.$disconnect();
    await h?.stop();
  });

  it("lists chunks and applies interval bounds", async () => {
    const chunks: string[] = await prisma.$timescale.showChunks("SensorReading");
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.includes("_hyper_"))).toBe(true);

    // The data is from early 2026; nothing is older than ~27 years before now, so the bound filters all out.
    expect(await prisma.$timescale.showChunks("SensorReading", { olderThan: "10000 days" })).toHaveLength(0);
  });

  it("compresses and decompresses a single chunk, idempotently", async () => {
    const [chunk] = await prisma.$timescale.showChunks("SensorReading");
    expect(await compressedChunks(h)).not.toContain(chunk);

    await prisma.$timescale.compressChunk(chunk);
    expect(await compressedChunks(h)).toContain(chunk);
    // Idempotent: re-compressing an already-compressed chunk is a no-op, not an error.
    await prisma.$timescale.compressChunk(chunk);
    expect(await compressedChunks(h)).toContain(chunk);

    await prisma.$timescale.decompressChunk(chunk);
    expect(await compressedChunks(h)).not.toContain(chunk);
    // Idempotent the other way too.
    await prisma.$timescale.decompressChunk(chunk);
    expect(await compressedChunks(h)).not.toContain(chunk);
  });
});
