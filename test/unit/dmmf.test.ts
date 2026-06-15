import { getDMMF } from "@prisma/internals";
import { describe, expect, it } from "vitest";
import { extractTimescaleSchema } from "../../src/generator/dmmf.js";

const HEADER = `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
  previewFeatures = ["views"]
}
datasource db {
  provider = "postgresql"
}
`;

async function extract(models: string) {
  const dmmf = await getDMMF({ datamodel: HEADER + models });
  return extractTimescaleSchema(dmmf);
}

// A plain source hypertable used by the cagg-focused cases.
const SOURCE = `
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  label       String
  @@id([deviceId, time])
}
`;

describe("extractTimescaleSchema — valid", () => {
  it("parses a full hypertable + continuous aggregate schema", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  @@id([deviceId, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupBy
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  maxTemp  Float    /// @timescale.aggregate(fn: "max", column: "temperature")
  @@unique([deviceId, bucket])
}
`);

    expect(result.hypertables).toEqual([{ table: "SensorReading", column: "time", chunkInterval: "1 day" }]);
    expect(result.continuousAggregates).toEqual([
      {
        name: "SensorHourly",
        source: "SensorReading",
        bucket: "1 hour",
        timeColumn: "time",
        bucketColumn: "bucket",
        groupBy: [{ source: "deviceId", output: "deviceId" }],
        aggregates: [
          { name: "avgTemp", fn: "avg", column: "temperature" },
          { name: "maxTemp", fn: "max", column: "temperature" },
        ],
        refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" },
      },
    ]);
  });

  it("omits chunkInterval and refresh when not specified", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  @@id([deviceId, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view SensorHourly {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([bucket])
}
`);
    expect(result.hypertables[0]).toEqual({ table: "SensorReading", column: "time" });
    expect(result.continuousAggregates[0]?.refresh).toBeUndefined();
    expect(result.continuousAggregates[0]?.groupBy).toEqual([]);
  });
});

describe("extractTimescaleSchema — hypertable errors", () => {
  const htModel = (ann: string) => `/// ${ann}
model M {
  id    Int      @id
  time  DateTime
  label String
}`;

  it("missing column arg", async () => {
    await expect(extract(htModel(`@timescale.hypertable(chunkInterval: "1 day")`))).rejects.toThrow(
      /missing or non-string argument "column"/,
    );
  });

  it("column is not a field", async () => {
    await expect(extract(htModel(`@timescale.hypertable(column: "nope")`))).rejects.toThrow(
      /column "nope" is not a scalar field/,
    );
  });

  it("column has a non-time type", async () => {
    await expect(extract(htModel(`@timescale.hypertable(column: "label")`))).rejects.toThrow(
      /must be a DateTime or integer field/,
    );
  });

  it("invalid chunkInterval", async () => {
    await expect(extract(htModel(`@timescale.hypertable(column: "time", chunkInterval: "1 fortnight")`))).rejects.toThrow(
      /Invalid interval/,
    );
  });
});

describe("extractTimescaleSchema — continuous aggregate errors", () => {
  const view = (ann: string, body: string) => `${SOURCE}
/// ${ann}
view V {
${body}
}
`;

  it("unknown source", async () => {
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "Nope", bucket: "1 hour", timeColumn: "time")`,
          `  bucket  DateTime /// @timescale.bucket\n  avgTemp Float /// @timescale.aggregate(fn: "avg", column: "temperature")\n  @@unique([bucket])`),
      ),
    ).rejects.toThrow(/source "Nope" is not a known model/);
  });

  it("timeColumn not on source", async () => {
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "nope")`,
          `  bucket  DateTime /// @timescale.bucket\n  avgTemp Float /// @timescale.aggregate(fn: "avg", column: "temperature")\n  @@unique([bucket])`),
      ),
    ).rejects.toThrow(/timeColumn "nope" does not exist on source/);
  });

  it("missing bucket field", async () => {
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")`,
          `  avgTemp Float /// @timescale.aggregate(fn: "avg", column: "temperature")\n  @@unique([avgTemp])`),
      ),
    ).rejects.toThrow(/missing the @timescale.bucket field/);
  });

  it("more than one bucket field", async () => {
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")`,
          `  bucket  DateTime /// @timescale.bucket\n  bucket2 DateTime /// @timescale.bucket\n  avgTemp Float /// @timescale.aggregate(fn: "avg", column: "temperature")\n  @@unique([bucket])`),
      ),
    ).rejects.toThrow(/more than one @timescale.bucket field/);
  });

  it("no aggregates", async () => {
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")`,
          `  bucket   DateTime /// @timescale.bucket\n  deviceId Int /// @timescale.groupBy\n  @@unique([deviceId, bucket])`),
      ),
    ).rejects.toThrow(/at least one @timescale.aggregate field is required/);
  });

  it("aggregate column not on source", async () => {
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")`,
          `  bucket  DateTime /// @timescale.bucket\n  avgX    Float /// @timescale.aggregate(fn: "avg", column: "nope")\n  @@unique([bucket])`),
      ),
    ).rejects.toThrow(/aggregate column "nope" does not exist on source/);
  });

  it("unsupported aggregate function", async () => {
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")`,
          `  bucket DateTime /// @timescale.bucket\n  med    Float /// @timescale.aggregate(fn: "median", column: "temperature")\n  @@unique([bucket])`),
      ),
    ).rejects.toThrow(/unsupported aggregate function "median"/);
  });

  it("timeColumn exists but is not a time type", async () => {
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "label")`,
          `  bucket  DateTime /// @timescale.bucket\n  avgTemp Float /// @timescale.aggregate(fn: "avg", column: "temperature")\n  @@unique([bucket])`),
      ),
    ).rejects.toThrow(/timeColumn "label" has type String; it must be a DateTime or integer field/);
  });

  it("source is a known model but not a hypertable", async () => {
    // SOURCE (SensorReading) here is a plain model — no @timescale.hypertable annotation.
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")`,
          `  bucket  DateTime /// @timescale.bucket\n  avgTemp Float /// @timescale.aggregate(fn: "avg", column: "temperature")\n  @@unique([bucket])`),
      ),
    ).rejects.toThrow(/source "SensorReading" must also be annotated with @timescale.hypertable/);
  });
});

describe("extractTimescaleSchema — @@map / @map", () => {
  it("resolves table/column names to DB names and records the column map", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime @map("ts")
  deviceId    Int      @map("device_id")
  temperature Float
  @@id([deviceId, time])
  @@map("sensor_readings")
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      @map("device_id") /// @timescale.groupBy
  avgTemp  Float    @map("avg_temp")  /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([deviceId, bucket])
  @@map("sensor_hourly")
}
`);

    expect(result.hypertables).toEqual([
      {
        model: "SensorReading",
        table: "sensor_readings",
        column: "ts",
        chunkInterval: "1 day",
        columns: { time: "ts", deviceId: "device_id" },
      },
    ]);
    expect(result.continuousAggregates).toEqual([
      {
        model: "SensorHourly",
        name: "sensor_hourly",
        source: "sensor_readings",
        bucket: "1 hour",
        timeColumn: "ts",
        bucketColumn: "bucket",
        groupBy: [{ source: "device_id", output: "device_id" }],
        aggregates: [{ name: "avg_temp", fn: "avg", column: "temperature" }],
      },
    ]);
  });
});
