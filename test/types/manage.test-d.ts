// Type-level tests for the $timescale model-name type-safety (checked by `npm run test:types`).
// A name argument is constrained to the registered model names, so a typo fails to compile.
import { timescaledb } from "../../src/index.js";
import type { CaggModelNames, HypertableModelNames, NamesOrString } from "../../src/client/index.js";
import type { TimescaleManage, TimescaleJob, JobStats, JobError } from "../../src/client/manage.js";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// --- 1) the generic namespace constrains the name arguments ---
declare const m: TimescaleManage<"SensorReading" | "DeviceLog", "SensorHourly">;

m.addRetentionPolicy("SensorReading", { dropAfter: "1 day" }); // ok
m.addRetentionPolicy("DeviceLog", { dropAfter: "1 day" }); // ok
m.removeRetentionPolicy("SensorReading"); // ok
m.refreshContinuousAggregate("SensorHourly"); // ok
m.addCompressionPolicy("SensorReading", { after: "7 days" }); // ok
m.addCompressionPolicy("DeviceLog", { after: "7 days", segmentBy: "x", orderBy: "x DESC" }); // ok
m.addCompressionPolicy("SensorReading", { after: "7 days", segmentBy: ["a"], orderBy: [{ column: "a", direction: "desc" }] }); // ok
m.removeCompressionPolicy("SensorReading"); // ok

// @ts-expect-error - "SensorRead" is not a registered hypertable
m.addRetentionPolicy("SensorRead", { dropAfter: "1 day" });
// @ts-expect-error - typo on remove
m.removeRetentionPolicy("SensorRaeding");
// @ts-expect-error - "SensorHrly" is not a registered continuous aggregate
m.refreshContinuousAggregate("SensorHrly");
// @ts-expect-error - "SensorRead" is not a registered hypertable
m.addCompressionPolicy("SensorRead", { after: "7 days" });
// @ts-expect-error - typo on the compression remove
m.removeCompressionPolicy("SensorRaeding");
// @ts-expect-error - `after` must be a valid interval (branded template)
m.addCompressionPolicy("SensorReading", { after: "7 fortnights" });

// The default (no type args) stays `string` for the manual / non-literal path.
declare const loose: TimescaleManage;
loose.addRetentionPolicy("anything", { dropAfter: "1 day" }); // ok — string fallback
loose.refreshContinuousAggregate("anything"); // ok
loose.addCompressionPolicy("anything", { after: "1 day" }); // ok — string fallback
loose.removeCompressionPolicy("anything"); // ok

// chunk + size helpers: model-name checked, with typed returns
m.dropChunks("SensorReading", { olderThan: "30 days" }); // ok (interval bound)
m.dropChunks("DeviceLog", { olderThan: "7 days", newerThan: "30 days" }); // ok (interval window)
const _bytes: Promise<bigint> = m.hypertableSize("SensorReading");
const _rows: Promise<bigint> = m.approximateRowCount("SensorReading");
const _dropped: Promise<string[]> = m.dropChunks("SensorReading", { olderThan: "1 day" });
void _bytes;
void _rows;
void _dropped;
void m.hypertableDetailedSize("SensorReading"); // Promise<HypertableSize>
void m.compressionStats("SensorReading"); // Promise<CompressionStats>
// @ts-expect-error - typo on the model name
m.dropChunks("SensorRead", { olderThan: "30 days" });
// @ts-expect-error - typo on the model name
m.hypertableSize("SensorRaeding");
// @ts-expect-error - dropChunks bounds are intervals relative to now, not Dates
m.dropChunks("SensorReading", { olderThan: new Date() });
loose.dropChunks("anything", { olderThan: "1 day" }); // ok — string fallback
loose.hypertableSize("anything"); // ok

// continuous-aggregate policy helpers: cagg-name checked
m.addContinuousAggregatePolicy("SensorHourly", { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" }); // ok
m.removeContinuousAggregatePolicy("SensorHourly"); // ok
// @ts-expect-error - "SensorHrly" is not a registered continuous aggregate
m.addContinuousAggregatePolicy("SensorHrly", { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" });
// @ts-expect-error - typo on the cagg name
m.removeContinuousAggregatePolicy("SensorHrly");
loose.addContinuousAggregatePolicy("anything", { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" }); // ok — string fallback
loose.removeContinuousAggregatePolicy("anything"); // ok — string fallback

// chunk skipping: hypertable model-name checked; the column is a free Prisma field-name string
m.enableChunkSkipping("SensorReading", "eventId"); // ok
m.disableChunkSkipping("DeviceLog", "eventId"); // ok
// @ts-expect-error - "SensorRead" is not a registered hypertable
m.enableChunkSkipping("SensorRead", "eventId");
// @ts-expect-error - typo on the model name
m.disableChunkSkipping("SensorRaeding", "eventId");
loose.enableChunkSkipping("anything", "eventId"); // ok — string fallback
loose.disableChunkSkipping("anything", "eventId"); // ok — string fallback

// chunk interval: hypertable model-name checked; interval is the branded template type
m.setChunkInterval("SensorReading", "6 hours"); // ok
m.setChunkInterval("DeviceLog", "1 day"); // ok
// @ts-expect-error - "SensorRead" is not a registered hypertable
m.setChunkInterval("SensorRead", "1 day");
// @ts-expect-error - `interval` must be a valid interval (branded template)
m.setChunkInterval("SensorReading", "1 fortnight");
loose.setChunkInterval("anything", "1 day"); // ok — string fallback

// jobs: introspection takes a hypertable OR cagg model (or nothing); control takes a numeric job id
const _jobs: Promise<TimescaleJob[]> = m.listJobs();
m.listJobs("SensorReading"); // ok (hypertable)
m.listJobs("SensorHourly"); // ok (cagg)
const _stats: Promise<JobStats[]> = m.jobStats("DeviceLog");
const _errs: Promise<JobError[]> = m.jobErrors();
void _jobs;
void _stats;
void _errs;
// @ts-expect-error - "Nope" is not a registered model
m.listJobs("Nope");
m.alterJob(1000, { scheduled: false }); // ok
m.alterJob(1000, { scheduleInterval: "6 hours", config: { drop_after: "60 days" } }); // ok
// @ts-expect-error - scheduleInterval must be a valid interval (branded template)
m.alterJob(1000, { scheduleInterval: "1 fortnight" });
// @ts-expect-error - a job id is a number, not a string
m.deleteJob("1000");
m.runJob(1002); // ok
loose.listJobs("anything"); // ok — string fallback
loose.alterJob(1, { scheduled: true }); // ok

// --- 2) name extraction from a const registry (model ?? table / model ?? name) ---
const mapped = {
  hypertables: [{ model: "SensorReading", table: "sensor_readings" }],
  continuousAggregates: [{ model: "SensorHourly", name: "sensor_hourly" }],
} as const;
type _mh = Expect<Equal<HypertableModelNames<typeof mapped>, "SensorReading">>;
type _mc = Expect<Equal<CaggModelNames<typeof mapped>, "SensorHourly">>;

// No @@map -> the model name is the table / view name.
const plain = {
  hypertables: [{ table: "SensorReading" }],
  continuousAggregates: [{ name: "SensorHourly" }],
} as const;
type _ph = Expect<Equal<HypertableModelNames<typeof plain>, "SensorReading">>;
type _pc = Expect<Equal<CaggModelNames<typeof plain>, "SensorHourly">>;

// Multiple hypertables -> a union.
const multi = { hypertables: [{ table: "A" }, { table: "B" }] } as const;
type _multi = Expect<Equal<HypertableModelNames<typeof multi>, "A" | "B">>;

// Nothing registered -> never -> widens back to string (helper stays callable).
type _none = Expect<Equal<NamesOrString<HypertableModelNames<Record<string, never>>>, string>>;

// --- 3) timescaledb() accepts the generated `as const` registry shape (end-to-end signature) ---
const registry = {
  hypertables: [{ model: "SensorReading", table: "sensor_readings", column: "ts", chunkInterval: "1 day" }],
  continuousAggregates: [
    {
      model: "SensorHourly",
      name: "sensor_hourly",
      source: "sensor_readings",
      bucket: "1 hour",
      timeColumn: "ts",
      bucketColumn: "bucket",
      aggregates: [{ name: "avgTemp", fn: "avg", column: "temperature" }],
    },
  ],
} as const;
void timescaledb(registry);
void timescaledb(); // no-arg path

export {};
