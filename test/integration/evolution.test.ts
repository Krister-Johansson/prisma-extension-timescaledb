// Schema EVOLUTION end-to-end on real TimescaleDB: the append-only versioned objects
// migrations must apply new timescale objects on `migrate deploy` after the first deploy
// (the pre-v1 fixed-name rewrite was silently skipped there), replay cleanly through
// `migrate reset` after a table is dropped (guarded blocks), and drop removed caggs.
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync, readFileSync } from "node:fs";
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
  console.warn("\n[integration] SKIPPED evolution.test.ts: Docker is not available. Schema evolution is NOT verified.\n");
}

const MODELS_V1 = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  @@id([deviceId, time])
}`;

// v2 adds a second hypertable AND a cagg on the first.
const MODELS_V2 = `${MODELS_V1}

/// @timescale.hypertable(column: "at", chunkInterval: "1 day")
model EventLog {
  at   DateTime
  id   Int
  kind String
  @@id([id, at])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view SensorHourly {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([bucket])
}`;

// v3 removes the cagg and the EventLog model (its table gets dropped by a Prisma migration).
const MODELS_V3 = MODELS_V1;

describe.skipIf(!DOCKER_OK)("schema evolution (real TimescaleDB)", () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness({ models: MODELS_V1 });
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  /** Swap the schema's model section in place (the harness header stays). */
  const setModels = (models: string): void => {
    const path = join(h.projectDir, "schema.prisma");
    const current = readFileSync(path, "utf8");
    const headerEnd = current.indexOf("\n\n/// @timescale");
    writeFileSync(path, current.slice(0, headerEnd) + "\n\n" + models, "utf8");
  };

  const hypertables = async (): Promise<string[]> =>
    (await h.query<{ hypertable_name: string }>(
      "SELECT hypertable_name FROM timescaledb_information.hypertables ORDER BY 1",
    )).map((r) => r.hypertable_name);

  const caggs = async (): Promise<string[]> =>
    (await h.query<{ view_name: string }>(
      "SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY 1",
    )).map((r) => r.view_name);

  it("v1 deploy converts the initial hypertable", async () => {
    expect(await hypertables()).toEqual(["SensorReading"]);
  });

  it("objects added AFTER the first deploy are applied by the next deploy (the pre-v1 silent-skip bug)", async () => {
    // The user's own Prisma migration for the new table + view.
    const migDir = join(h.projectDir, "migrations", "20260102000000_add_eventlog");
    execFileSync("mkdir", ["-p", migDir]);
    writeFileSync(
      join(migDir, "migration.sql"),
      `CREATE TABLE "EventLog" ("at" TIMESTAMP(3) NOT NULL, "id" INTEGER NOT NULL, "kind" TEXT NOT NULL,
  CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id","at"));`,
      "utf8",
    );
    setModels(MODELS_V2);
    h.prisma(["generate"]); // appends 99999999999999_timescaledb_objects_v0002
    h.prisma(["migrate", "deploy"]);

    // Before the fix: deploy exited 0 with "No pending migrations" and EventLog stayed a plain table.
    expect(await hypertables()).toEqual(["EventLog", "SensorReading"]);
    expect(await caggs()).toEqual(["SensorHourly"]);

    const folders = readdirSync(join(h.projectDir, "migrations")).sort();
    expect(folders).toContain("99999999999999_timescaledb_objects_v0001");
    expect(folders).toContain("99999999999999_timescaledb_objects_v0002");
  });

  it("regenerating an unchanged schema adds no migration", async () => {
    const before = readdirSync(join(h.projectDir, "migrations")).sort();
    h.prisma(["generate"]);
    expect(readdirSync(join(h.projectDir, "migrations")).sort()).toEqual(before);
  });

  it("removing objects drops the cagg, and reset replays the whole history cleanly (guards)", async () => {
    // The user's Prisma migration dropping the EventLog table.
    const migDir = join(h.projectDir, "migrations", "20260103000000_drop_eventlog");
    execFileSync("mkdir", ["-p", migDir]);
    writeFileSync(join(migDir, "migration.sql"), `DROP TABLE "EventLog";`, "utf8");
    setModels(MODELS_V3);
    h.prisma(["generate"]); // appends v0003: drops SensorHourly, re-asserts SensorReading
    h.prisma(["migrate", "deploy"]);

    expect(await hypertables()).toEqual(["SensorReading"]);
    expect(await caggs()).toEqual([]);

    // The reset-safety guarantee under evolution: a full replay includes v0002, whose EventLog
    // conversion and SensorHourly cagg now target relations that later migrations dropped.
    // The guarded blocks skip them; the final state converges. Pre-fix this errored
    // ("relation does not exist") and broke reset outright.
    h.prisma(["migrate", "reset", "--force"]);
    expect(await hypertables()).toEqual(["SensorReading"]);
    expect(await caggs()).toEqual([]);
  });
});
