// Constraint 4 (CLAUDE.md): a continuous aggregate shows up in the views catalog, but plain
// `DROP VIEW` errors on it — down-migrations MUST use `DROP MATERIALIZED VIEW`. Because
// `migrate reset` only replays UP migrations, the generated `down` SQL is otherwise never
// executed against a real database (it's only asserted as a string snapshot in unit tests).
// This proves it end to end: `DROP VIEW` is rejected, the generated `DROP MATERIALIZED VIEW`
// drops the cagg cleanly, and re-running it is an idempotent no-op (constraint 3).
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "./harness.js";
import { createContinuousAggregateSql } from "../../src/core/index.js";
import type { CaggConfig } from "../../src/core/types.js";

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
    "\n[integration] SKIPPED: Docker is not available. Down-migration (constraint 4) is NOT verified.\n",
  );
}

// Mirrors the harness DEFAULT_MODELS `SensorHourly` cagg. Only `name`/`schema` drive the
// `down` SQL, but the builder validates the whole config, so it must be well-formed.
const SENSOR_HOURLY: CaggConfig = {
  name: "SensorHourly",
  source: "SensorReading",
  bucket: "1 hour",
  timeColumn: "time",
  bucketColumn: "bucket",
  aggregates: [{ name: "avgTemp", fn: "avg", column: "temperature" }],
  groupBy: [{ source: "deviceId", output: "deviceId" }],
};

async function caggCount(h: Harness): Promise<number> {
  const [row] = await h.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM timescaledb_information.continuous_aggregates WHERE view_name = 'SensorHourly'",
  );
  return row?.n ?? 0;
}

describe.skipIf(!DOCKER_OK)("down-migrations (constraint 4: DROP MATERIALIZED VIEW)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it("rejects plain DROP VIEW on a continuous aggregate (the reason constraint 4 exists)", async () => {
    expect(await caggCount(h)).toBe(1);
    // TimescaleDB itself blocks DROP VIEW on a cagg ("cannot drop continuous aggregate using
    // DROP VIEW"), and IF EXISTS does not suppress that — which is exactly why the generated
    // `down` must use DROP MATERIALIZED VIEW.
    await expect(h.query('DROP VIEW IF EXISTS "SensorHourly"')).rejects.toThrow(
      /continuous aggregate|materialized view|not a view/i,
    );
    expect(await caggCount(h)).toBe(1); // the rejected drop changed nothing
  });

  it("drops the cagg with the generated DROP MATERIALIZED VIEW down SQL, idempotently", async () => {
    const { down } = createContinuousAggregateSql(SENSOR_HOURLY);
    expect(down).toMatch(/DROP MATERIALIZED VIEW IF EXISTS/);
    expect(await caggCount(h)).toBe(1);

    await h.query(down);
    expect(await caggCount(h)).toBe(0);

    // `IF EXISTS` makes a replay / second down-run a no-op rather than an error (constraint 3).
    await expect(h.query(down)).resolves.toBeDefined();
    expect(await caggCount(h)).toBe(0);
  });
});
