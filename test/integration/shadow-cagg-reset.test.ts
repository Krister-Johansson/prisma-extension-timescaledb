// The shadow database keeps a continuous aggregate, and dropping one needs DROP MATERIALIZED
// VIEW (#135).
//
// `migrate dev` replays the migration history onto the shadow database and leaves it there, cagg
// included. Prisma's own cleanup of that shadow is a *soft* reset — `best_effort_reset`, taken
// whenever `shadowDatabaseUrl` is configured, which this package requires — and it drops views
// before tables using `DROP VIEW`. TimescaleDB refuses that on a cagg:
//
//   Error: P3016
//   ERROR: cannot drop continuous aggregate using DROP VIEW
//   HINT: Use DROP MATERIALIZED VIEW to drop a continuous aggregate.
//
// Whether Prisma resets the shadow on any given run is NOT established (see #135; nine controlled
// replays never reproduced it while the real test failed roughly one run in three). What IS
// established is everything below: the shadow really does hold the cagg, DROP VIEW really does
// fail on it, and DROP MATERIALIZED VIEW really is the way out. That is the mechanism the README
// documents a recovery for, and the recovery is what `resetShadow()` performs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { startHarness, type Harness, dockerAvailable } from "./harness.js";

const DOCKER_OK = dockerAvailable("The shadow-database cagg hazard is NOT verified.");

/** Continuous aggregates TimescaleDB reports in a database. */
async function caggs(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{ view_name: string }>(
      "SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY 1",
    );
    return res.rows.map((r) => r.view_name);
  } finally {
    await client.end();
  }
}

/** Run one statement, returning the error message instead of throwing. */
async function tryStatement(connectionString: string, sql: string): Promise<string | null> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await client.end();
  }
}

describe.skipIf(!DOCKER_OK)("the shadow database and continuous aggregates", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
    // Populates the shadow: migrate dev replays the whole history onto it.
    await h.resetShadow();
    h.prisma(["migrate", "dev", "--create-only", "--name", "populate_shadow"]);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("leaves the continuous aggregate behind in the shadow database", async () => {
    // This is what makes the hazard reachable at all: the cagg is still sitting in the shadow
    // when the next migrate dev runs, waiting for a reset to trip over.
    expect(await caggs(h.shadowUrl)).toContain("SensorHourly");
  });

  it("refuses DROP VIEW on it, which is what Prisma's soft reset issues", async () => {
    const err = await tryStatement(h.shadowUrl, 'DROP VIEW "SensorHourly"');
    expect(err).toMatch(/cannot drop continuous aggregate using DROP VIEW/);
    // Still there: the failed drop changed nothing.
    expect(await caggs(h.shadowUrl)).toContain("SensorHourly");
  });

  it("accepts DROP MATERIALIZED VIEW, which is what resetShadow uses", async () => {
    await h.resetShadow();
    expect(await caggs(h.shadowUrl)).not.toContain("SensorHourly");
  });

  it("lets migrate dev run again once the shadow is clear", async () => {
    await h.resetShadow();
    expect(() => h.prisma(["migrate", "dev", "--name", "after_recovery"])).not.toThrow();
  }, 120_000);
});
