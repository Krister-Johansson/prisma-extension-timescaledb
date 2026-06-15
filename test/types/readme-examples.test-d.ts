// Compile-check for the documented public API used in README examples that don't require a
// generated Prisma client. (The full runtime client example is validated by the
// integration test against a real generated client.)
import { timescaledb } from "../../src/index.js";
import {
  createContinuousAggregateSql,
  createExtensionSql,
  createHypertableSql,
  type MigrationSql,
} from "../../src/core/index.js";

// "Without the generator (manual config)" — must type-check.
const extension = timescaledb({
  hypertables: [{ table: "SensorReading", column: "time", chunkInterval: "1 day" }],
});
void extension;

// Manual config with @@map / @map renaming — must type-check.
const mapped = timescaledb({
  hypertables: [
    { model: "SensorReading", table: "sensor_readings", column: "ts", columns: { deviceId: "device_id" } },
  ],
});
void mapped;

// Core SQL builders exported from "prisma-extension-timescaledb/core".
const ext: MigrationSql = createExtensionSql();
const hyper: MigrationSql = createHypertableSql({ table: "SensorReading", column: "time", chunkInterval: "1 day" });
const cagg: MigrationSql = createContinuousAggregateSql({
  name: "SensorHourly",
  source: "SensorReading",
  bucket: "1 hour",
  timeColumn: "time",
  bucketColumn: "bucket",
  groupBy: [{ source: "deviceId", output: "deviceId" }],
  aggregates: [{ name: "avgTemp", fn: "avg", column: "temperature" }],
  refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" },
});
void ext;
void hyper;
void cagg;

export {};
