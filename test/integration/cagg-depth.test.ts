// Continuous-aggregate depth, end-to-end on real TimescaleDB:
//   - a real-time cagg (materializedOnly: false) and
//   - a HIERARCHICAL cagg whose source is another cagg (daily rolled up from hourly).
// The reset-safety run is the real proof: `migrate reset` replays the managed migration from
// scratch, so the inner cagg must be emitted before the outer or the replay would fail. Verified
// against timescaledb_information.continuous_aggregates, including migrate reset (twice).
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
  console.warn("\n[integration] SKIPPED cagg-depth.test.ts: Docker is not available. Not verified.\n");
}

// SensorReading matches the harness's default CREATE TABLE (time / deviceId / temperature).
const MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", materializedOnly: false)
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupBy
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "temperature")

  @@unique([deviceId, bucket])
}

/// @timescale.continuousAggregate(source: "SensorHourly", bucket: "1 day", timeColumn: "bucket")
view SensorDaily {
  day      DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupBy
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "avgTemp")

  @@unique([deviceId, day])
}`;

/** view_name -> materialized_only for SensorReading's continuous aggregates. */
async function caggs(h: Harness): Promise<Record<string, boolean>> {
  const rows = await h.query<{ name: string; mat_only: boolean }>(
    "SELECT view_name AS name, materialized_only AS mat_only FROM timescaledb_information.continuous_aggregates ORDER BY view_name",
  );
  return Object.fromEntries(rows.map((r) => [r.name, r.mat_only]));
}

describe.skipIf(!DOCKER_OK)("continuous-aggregate depth (generated, reset-safe)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ models: MODELS });
    h.prisma(["generate"]);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it("creates a real-time cagg + a hierarchical cagg-on-cagg, reproduced across migrate reset", async () => {
    h.prisma(["migrate", "deploy"]);
    const c = await caggs(h);
    expect(Object.keys(c).sort()).toEqual(["SensorDaily", "SensorHourly"]);
    expect(c.SensorHourly).toBe(false); // materializedOnly: false -> real-time
    expect(c.SensorDaily).toBe(true); // default (materialized-only) on 2.18+

    // Reset replays the managed migration from scratch — the hierarchical (daily-on-hourly) order
    // must hold or the replay errors. Run twice (idempotent, zero manual steps).
    h.prisma(["migrate", "reset", "--force"]);
    expect(await caggs(h)).toEqual({ SensorHourly: false, SensorDaily: true });
    h.prisma(["migrate", "reset", "--force"]);
    expect(await caggs(h)).toEqual({ SensorHourly: false, SensorDaily: true });
  });
});
