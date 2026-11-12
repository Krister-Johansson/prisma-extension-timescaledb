// Issue #173 end-to-end on real TimescaleDB. A hypertable annotation removed in one version and
// added back with another layout in the next must be refused: at `prisma generate` when the
// state file still knows the old layout, and at `migrate deploy` when it does not (a lost state
// file). In both cases the live hypertable keeps its dimensions and the history still replays
// through `migrate reset`.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness, dockerAvailable } from "./harness.js";

const DOCKER_OK = dockerAvailable("The hypertable layout check across an annotation removal is NOT verified.");

const INIT_SQL = `CREATE TABLE "SensorReading" (
  "time" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "deviceId" INTEGER NOT NULL,
  "sensorId" INTEGER NOT NULL,
  "temperature" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("deviceId","sensorId","time","createdAt")
);`;

const MODEL = `model SensorReading {
  time        DateTime @db.Timestamptz
  createdAt   DateTime @db.Timestamptz
  deviceId    Int
  sensorId    Int
  temperature Float
  @@id([deviceId, sensorId, time, createdAt])
}`;
const annotated = (column: string, partitionColumn: string): string =>
  `/// @timescale.hypertable(column: "${column}", chunkInterval: "1 day", partitionColumn: "${partitionColumn}", partitions: 4)\n${MODEL}`;

const HASHED_ON_DEVICE = annotated("time", "deviceId");
const HASHED_ON_SENSOR = annotated("time", "sensorId");
const OTHER_TIME_COLUMN = annotated("createdAt", "deviceId");

const objects = (n: number): string => `99999999999999_timescaledb_objects_v000${n}`;

describe.skipIf(!DOCKER_OK)("hypertable layout across an annotation removal (real TimescaleDB)", () => {
  let h: Harness;
  let header: string;
  let migrations: string;
  let statePath: string;

  beforeAll(async () => {
    h = await startHarness({ models: HASHED_ON_DEVICE, initSql: INIT_SQL });
    const schema = readFileSync(join(h.projectDir, "schema.prisma"), "utf8");
    header = schema.slice(0, schema.indexOf("/// @timescale"));
    migrations = join(h.projectDir, "migrations");
    statePath = join(migrations, ".prisma-extension-timescaledb.json");
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  const setModels = (models: string): void => {
    writeFileSync(join(h.projectDir, "schema.prisma"), header + models + "\n", "utf8");
  };

  /** The live layout: `column:type` per dimension, in dimension order. */
  const dimensions = async (): Promise<string[]> =>
    (
      await h.query<{ d: string }>(
        `SELECT column_name || ':' || dimension_type AS d FROM timescaledb_information.dimensions
          WHERE hypertable_name = 'SensorReading' ORDER BY dimension_number`,
      )
    ).map((r) => r.d);

  const folders = (): string[] => readdirSync(migrations).sort();

  it("v1 deploys a hypertable hashed on deviceId", async () => {
    expect(await dimensions()).toEqual(["time:Time", "deviceId:Space"]);
  });

  it("v2 removes the annotation: the table stays a hypertable and the state file keeps its layout", async () => {
    setModels(MODEL);
    h.prisma(["generate"]);
    expect(folders()).toContain(objects(2));
    h.prisma(["migrate", "deploy"]);
    expect(await dimensions()).toEqual(["time:Time", "deviceId:Space"]);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { version: number; state: { formerHypertables?: unknown } };
    expect(state.version).toBe(2);
    expect(state.state.formerHypertables).toEqual([
      { table: "SensorReading", column: "time", spacePartition: { column: "deviceId" } },
    ]);
  });

  it("v3 with another layout is refused at generate time and writes nothing", async () => {
    const before = folders();
    const stateBefore = readFileSync(statePath, "utf8");

    setModels(HASHED_ON_SENSOR);
    expect(() => h.prisma(["generate"])).toThrow(/space partition column changed from "deviceId" to "sensorId"/);
    setModels(OTHER_TIME_COLUMN);
    expect(() => h.prisma(["generate"])).toThrow(/time column changed from "time" to "createdAt"/);

    expect(folders()).toEqual(before);
    expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(await dimensions()).toEqual(["time:Time", "deviceId:Space"]);
  });

  it("the v1, v2 history replays through migrate reset and migrate deploy", async () => {
    h.prisma(["migrate", "reset", "--force"]);
    h.prisma(["migrate", "deploy"]);
    expect(await dimensions()).toEqual(["time:Time", "deviceId:Space"]);
  });

  // With the state file gone the generator has nothing to compare against, so v3 is written.
  // The check in the hypertable block stops it at deploy, before add_dimension adds a third
  // dimension.
  it("a lost state file lets v3 through generate, and migrate deploy refuses it", async () => {
    rmSync(statePath);
    setModels(HASHED_ON_SENSOR);
    h.prisma(["generate"]);
    expect(folders()).toContain(objects(3));

    expect(() => h.prisma(["migrate", "deploy"])).toThrow(
      /hypertable "SensorReading" has a space dimension on "deviceId", but the schema declares a space dimension on "sensorId"/,
    );
    expect(await dimensions()).toEqual(["time:Time", "deviceId:Space"]);
  });

  it("recovers from the refused migration: roll it back, delete it, declare the live layout", async () => {
    h.prisma(["migrate", "resolve", "--rolled-back", objects(3)]);
    rmSync(join(migrations, objects(3)), { recursive: true });
    setModels(HASHED_ON_DEVICE);
    h.prisma(["generate"]); // the #170 healing path rebuilds the lost v0003 as v0004
    expect(folders()).toContain(objects(4));
    expect(existsSync(join(migrations, objects(3)))).toBe(false);

    h.prisma(["migrate", "deploy"]);
    expect(await dimensions()).toEqual(["time:Time", "deviceId:Space"]);
    h.prisma(["migrate", "reset", "--force"]);
    h.prisma(["migrate", "deploy"]);
    expect(await dimensions()).toEqual(["time:Time", "deviceId:Space"]);
  });

  it("a lost state file with another time column is refused at deploy too", async () => {
    rmSync(statePath);
    setModels(OTHER_TIME_COLUMN);
    h.prisma(["generate"]);
    expect(folders()).toContain(objects(5));
    expect(() => h.prisma(["migrate", "deploy"])).toThrow(
      /hypertable "SensorReading" is partitioned on time column "time", but the schema declares "createdAt"/,
    );
    expect(await dimensions()).toEqual(["time:Time", "deviceId:Space"]);
  });
});
