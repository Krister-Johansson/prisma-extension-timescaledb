// `prisma migrate dev` must not invent work of its own after a hypertable conversion.
//
// Left to its defaults, `create_hypertable` adds an index on the time column
// (`SensorReading_time_idx`) whenever no index already starts with that column. Nothing in
// schema.prisma declares it, so Prisma reads it as drift and writes a migration that drops it.
// That migration carries a real timestamp, so it sorts BEFORE the objects migration that does
// the conversion, and the next `migrate reset` replays the drop against an index nothing has
// created yet:
//
//   Applying migration `20260904135248_probe`
//   ERROR: index "SensorReading_time_idx" does not exist
//
// The builder passes `create_default_indexes => FALSE`, which leaves the Prisma schema as the
// only thing that creates indexes on the table, so there is nothing for Prisma to read as drift.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  console.warn(
    "\n[integration] SKIPPED migrate-dev-drift.test.ts: Docker is not available. migrate dev after a hypertable conversion is NOT verified.\n",
  );
}

/** Every migration.sql in the project, so a drift migration cannot hide in a new folder. */
function migrationSql(h: Harness): string {
  const dir = join(h.projectDir, "migrations");
  return readdirSync(dir)
    .filter((name) => !name.endsWith(".toml") && !name.startsWith("."))
    .map((name) => readFileSync(join(dir, name, "migration.sql"), "utf8"))
    .join("\n");
}

async function indexes(h: Harness): Promise<string[]> {
  return (
    await h.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'SensorReading' ORDER BY 1",
    )
  ).map((r) => r.indexname);
}

describe.skipIf(!DOCKER_OK)("migrate dev after a hypertable conversion", () => {
  let h: Harness;

  beforeAll(async () => {
    // The harness default models declare @@index([deviceId, time]), which does NOT start with the
    // time column, so TimescaleDB's default index would have been created alongside it.
    h = await startHarness();
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("creates only the indexes the Prisma schema declares", async () => {
    expect(await indexes(h)).toEqual(["SensorReading_deviceId_time_idx", "SensorReading_pkey"]);
  });

  it("writes no drift migration on migrate dev --create-only (the documented flow)", () => {
    h.prisma(["migrate", "dev", "--create-only", "--name", "check"]);
    expect(migrationSql(h)).not.toContain("DropIndex");
    expect(migrationSql(h)).not.toContain("DROP INDEX");
  }, 120_000);

  it("writes no drift migration on a full migrate dev either", () => {
    h.prisma(["migrate", "dev", "--name", "check_applied"]);
    expect(migrationSql(h)).not.toContain("DROP INDEX");
  }, 120_000);

  // The payoff: with no drift migration in front of it, the objects migration still replays.
  it("still reproduces the hypertable after migrate reset + deploy", async () => {
    h.prisma(["migrate", "reset", "--force"]);
    h.prisma(["migrate", "deploy"]);

    const [row] = await h.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM timescaledb_information.hypertables WHERE hypertable_name = 'SensorReading'",
    );
    expect(row?.n).toBe(1);
    expect(await indexes(h)).toEqual(["SensorReading_deviceId_time_idx", "SensorReading_pkey"]);
  }, 120_000);
});
