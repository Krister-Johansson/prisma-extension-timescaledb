// Type-level tests for the $timescale model-name type-safety (checked by `npm run test:types`).
// A name argument is constrained to the registered model names, so a typo fails to compile.
import { timescaledb } from "../../src/index.js";
import type { CaggModelNames, HypertableModelNames, NamesOrString } from "../../src/client/index.js";
import type { TimescaleManage } from "../../src/client/manage.js";

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
