// Schema EVOLUTION end-to-end on real TimescaleDB: the append-only versioned objects
// migrations must apply new timescale objects on `migrate deploy` after the first deploy
// (the pre-v1 fixed-name rewrite was silently skipped there), replay cleanly through
// `migrate reset` after a table is dropped (guarded blocks), and drop removed caggs.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness, dockerAvailable } from "./harness.js";

const DOCKER_OK = dockerAvailable("Schema evolution is NOT verified.");

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

// v4 adds a retention policy to the remaining hypertable.
const MODELS_V4 = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.retention(dropAfter: "30 days")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  @@id([deviceId, time])
}`;

// v5 adds a cagg back; v6 replaces its definition (a wider bucket).
const caggModels = (bucket: string): string => `${MODELS_V4}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "${bucket}", timeColumn: "time")
view SensorHourly {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([bucket])
}`;
const MODELS_V5 = caggModels("1 hour");
const MODELS_V6 = caggModels("2 hours");

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

  const policies = async (): Promise<string[]> =>
    (await h.query<{ proc_name: string }>(
      "SELECT proc_name FROM timescaledb_information.jobs WHERE hypertable_name = 'SensorReading' ORDER BY 1",
    )).map((r) => r.proc_name);

  // Issue #160: the state file said v0004 had been emitted, so once its folder was gone every
  // later generate compared the unchanged schema against the recorded state and wrote nothing.
  it("deleting the latest objects migration before deploying it re-emits the state as the next version", async () => {
    const migrations = join(h.projectDir, "migrations");
    setModels(MODELS_V4);
    h.prisma(["generate"]); // appends v0004: adds the retention policy
    expect(readdirSync(migrations)).toContain("99999999999999_timescaledb_objects_v0004");

    // The developer discards the undeployed migration to redo it.
    rmSync(join(migrations, "99999999999999_timescaledb_objects_v0004"), { recursive: true });
    h.prisma(["generate"]);
    const folders = readdirSync(migrations).sort();
    expect(folders).not.toContain("99999999999999_timescaledb_objects_v0004"); // a number is never reused
    expect(folders).toContain("99999999999999_timescaledb_objects_v0005");
    const v5 = readFileSync(join(migrations, "99999999999999_timescaledb_objects_v0005", "migration.sql"), "utf8");
    expect(v5).toContain(`add_retention_policy('"SensorReading"'`);

    h.prisma(["migrate", "deploy"]);
    expect(await policies()).toEqual(["policy_retention"]);

    // The healed history still replays from scratch.
    h.prisma(["migrate", "reset", "--force"]);
    expect(await hypertables()).toEqual(["SensorReading"]);
    expect(await policies()).toEqual(["policy_retention"]);
  });

  // Issue #160, the replacement path: the saved state already says "2 hours", so a diff against
  // it has no drop, and the guarded create would keep the "1 hour" view on a replay. The rebuilt
  // migration must carry the drop the lost one had.
  it("deleting a lost migration that replaced a cagg definition rebuilds it with the drop", async () => {
    const migrations = join(h.projectDir, "migrations");
    setModels(MODELS_V5);
    h.prisma(["generate"]); // v0006: creates SensorHourly at 1 hour
    h.prisma(["migrate", "deploy"]);
    expect(await caggs()).toEqual(["SensorHourly"]);

    setModels(MODELS_V6);
    h.prisma(["generate"]); // v0007: drops and recreates SensorHourly at 2 hours
    expect(readdirSync(migrations)).toContain("99999999999999_timescaledb_objects_v0007");
    rmSync(join(migrations, "99999999999999_timescaledb_objects_v0007"), { recursive: true });
    h.prisma(["generate"]); // v0008 rebuilds v0007 from the recorded previous state
    const v8 = readFileSync(join(migrations, "99999999999999_timescaledb_objects_v0008", "migration.sql"), "utf8");
    expect(v8).toContain(`DROP MATERIALIZED VIEW IF EXISTS "SensorHourly"`);
    expect(v8).toContain(`time_bucket('2 hours'`);

    const bucketWidth = async (): Promise<string[]> =>
      (await h.query<{ view_definition: string }>(
        "SELECT view_definition FROM timescaledb_information.continuous_aggregates WHERE view_name = 'SensorHourly'",
      )).map((r) => r.view_definition);
    h.prisma(["migrate", "deploy"]);
    await expect(bucketWidth()).resolves.toEqual([expect.stringContaining("'02:00:00'")]);
    h.prisma(["migrate", "reset", "--force"]);
    await expect(bucketWidth()).resolves.toEqual([expect.stringContaining("'02:00:00'")]);
  });

  // Issue #160: a read error other than "no such file" must stop the run. Reading it as a first
  // run put a full re-assert migration on disk and then failed on the state write.
  it("an unreadable state file stops generate without writing a migration", () => {
    const migrations = join(h.projectDir, "migrations");
    const statePath = join(migrations, ".prisma-extension-timescaledb.json");
    const original = readFileSync(statePath, "utf8");
    const before = readdirSync(migrations).sort();
    rmSync(statePath);
    mkdirSync(statePath); // a directory where the file should be: EISDIR on read
    try {
      expect(() => h.prisma(["generate"])).toThrow(/EISDIR/);
      expect(readdirSync(migrations).sort()).toEqual(before);
    } finally {
      rmSync(statePath, { recursive: true });
      writeFileSync(statePath, original, "utf8");
    }
  });

  // Issue #160: a version-2 file used to read as corrupt, which emitted a full re-assert
  // migration and rewrote the file as version 1.
  it("a state file from a newer release stops generate instead of being overwritten", () => {
    const migrations = join(h.projectDir, "migrations");
    const statePath = join(migrations, ".prisma-extension-timescaledb.json");
    const original = readFileSync(statePath, "utf8");
    const before = readdirSync(migrations).sort();
    writeFileSync(statePath, JSON.stringify({ ...(JSON.parse(original) as object), version: 2 }), "utf8");
    try {
      expect(() => h.prisma(["generate"])).toThrow(/newer prisma-extension-timescaledb/);
      expect((JSON.parse(readFileSync(statePath, "utf8")) as { version: number }).version).toBe(2);
      expect(readdirSync(migrations).sort()).toEqual(before);
    } finally {
      writeFileSync(statePath, original, "utf8");
    }
  });
});
