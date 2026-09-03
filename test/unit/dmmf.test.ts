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
  id    Int
  time  DateTime
  label String
  @@id([id, time])
}`;

  it("missing column arg", async () => {
    await expect(extract(htModel(`@timescale.hypertable(chunkInterval: "1 day")`))).rejects.toThrow(
      /missing or non-string argument "column"/,
    );
  });

  it("column is not a field", async () => {
    await expect(extract(htModel(`@timescale.hypertable(column: "nope")`))).rejects.toThrow(
      /column "nope" is not a scalar or enum field/,
    );
  });

  it("column has a non-time type", async () => {
    await expect(extract(htModel(`@timescale.hypertable(column: "label")`))).rejects.toThrow(
      /must be a DateTime field/,
    );
  });

  it("rejects an integer time column up front (not supported yet — would fail at migrate)", async () => {
    await expect(extract(htModel(`@timescale.hypertable(column: "id")`))).rejects.toThrow(
      /has type Int; the partitioning column must be a DateTime field \(integer time columns are not supported yet\)/,
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
    ).rejects.toThrow(/timeColumn "label" has type String; it must be a DateTime field/);
  });

  it("rejects an integer timeColumn up front (DateTime-only contract for caggs too)", async () => {
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "deviceId")`,
          `  bucket  DateTime /// @timescale.bucket\n  avgTemp Float /// @timescale.aggregate(fn: "avg", column: "temperature")\n  @@unique([bucket])`),
      ),
    ).rejects.toThrow(
      /timeColumn "deviceId" has type Int; it must be a DateTime field \(integer time columns are not supported yet\)/,
    );
  });

  it("source is a known model but neither a hypertable nor a continuous aggregate", async () => {
    // SOURCE (SensorReading) here is a plain model — no @timescale.hypertable annotation.
    await expect(
      extract(
        view(`@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")`,
          `  bucket  DateTime /// @timescale.bucket\n  avgTemp Float /// @timescale.aggregate(fn: "avg", column: "temperature")\n  @@unique([bucket])`),
      ),
    ).rejects.toThrow(/source "SensorReading" must be a @timescale.hypertable or another @timescale.continuousAggregate/);
  });
});

describe("extractTimescaleSchema — cagg depth (hierarchical + materialized_only)", () => {
  const HT = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  temperature Float
  @@id([time])
}`;

  it("parses materializedOnly: false (real-time aggregation)", async () => {
    const result = await extract(`${HT}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", materializedOnly: false)
view SensorHourly {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([bucket])
}`);
    expect(result.continuousAggregates[0]?.materializedOnly).toBe(false);
  });

  it("accepts a hierarchical cagg whose source is another continuous aggregate", async () => {
    const result = await extract(`${HT}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view SensorHourly {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([bucket])
}

/// @timescale.continuousAggregate(source: "SensorHourly", bucket: "1 day", timeColumn: "bucket")
view SensorDaily {
  day     DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "avgTemp")
  @@unique([day])
}`);
    const daily = result.continuousAggregates.find((c) => c.name === "SensorDaily");
    expect(daily?.source).toBe("SensorHourly");
    expect(daily?.timeColumn).toBe("bucket");
  });

  it("rejects a continuous aggregate that is its own source", async () => {
    await expect(
      extract(`${HT}

/// @timescale.continuousAggregate(source: "SensorHourly", bucket: "1 hour", timeColumn: "bucket")
view SensorHourly {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "avgTemp")
  @@unique([bucket])
}`),
    ).rejects.toThrow(/cannot be its own source/);
  });
});

describe("extractTimescaleSchema — @@schema (multiSchema)", () => {
  it("resolves @@schema to schema / sourceSchema on the configs", async () => {
    const dmmf = await getDMMF({
      datamodel: `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
  previewFeatures = ["views", "multiSchema"]
}
datasource db {
  provider = "postgresql"
  schemas  = ["public", "metrics"]
}

/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  @@id([deviceId, time])
  @@schema("metrics")
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view SensorHourly {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([bucket])
  @@schema("metrics")
}
`,
    });
    const result = extractTimescaleSchema(dmmf);
    expect(result.hypertables[0]).toMatchObject({ table: "SensorReading", schema: "metrics" });
    expect(result.continuousAggregates[0]).toMatchObject({
      name: "SensorHourly",
      schema: "metrics",
      source: "SensorReading",
      sourceSchema: "metrics",
    });
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

describe("extractTimescaleSchema — retention", () => {
  it("parses @timescale.retention(dropAfter) on a hypertable", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.retention(dropAfter: "30 days")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`);
    expect(result.hypertables).toEqual([
      { table: "SensorReading", column: "time", chunkInterval: "1 day", retention: { dropAfter: "30 days" } },
    ]);
  });

  it("rejects @timescale.retention without @timescale.hypertable", async () => {
    await expect(
      extract(`
/// @timescale.retention(dropAfter: "30 days")
model Plain {
  id   Int      @id
  time DateTime
}
`),
    ).rejects.toThrow(/only valid together with @timescale.hypertable/);
  });

  it("requires the dropAfter argument", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
/// @timescale.retention
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/missing or non-string argument "dropAfter"/);
  });

  it("rejects an invalid dropAfter interval", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
/// @timescale.retention(dropAfter: "1 fortnight")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/Invalid interval/);
  });
});

describe("extractTimescaleSchema — compression", () => {
  it("parses @timescale.compression(after, segmentBy, orderBy) on a hypertable", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.compression(after: "7 days", segmentBy: "deviceId", orderBy: "time DESC")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`);
    expect(result.hypertables).toEqual([
      {
        table: "SensorReading",
        column: "time",
        chunkInterval: "1 day",
        compression: {
          after: "7 days",
          segmentBy: ["deviceId"],
          orderBy: [{ column: "time", direction: "desc" }],
        },
      },
    ]);
  });

  it("supports multi-column segmentBy / orderBy (with NULLS) and maps @map names", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.compression(after: "7 days", segmentBy: "deviceId, siteId", orderBy: "time DESC, deviceId ASC NULLS LAST")
model SensorReading {
  time     DateTime @map("ts")
  deviceId Int      @map("device_id")
  siteId   Int
  @@id([deviceId, time])
  @@map("sensor_readings")
}
`);
    expect(result.hypertables[0]?.compression).toEqual({
      after: "7 days",
      segmentBy: ["device_id", "siteId"],
      orderBy: [
        { column: "ts", direction: "desc" },
        { column: "device_id", direction: "asc", nulls: "last" },
      ],
    });
  });

  it("omits segmentBy / orderBy when only `after` is given", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time")
/// @timescale.compression(after: "30 days")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`);
    expect(result.hypertables[0]?.compression).toEqual({ after: "30 days" });
  });

  it("rejects @timescale.compression without @timescale.hypertable", async () => {
    await expect(
      extract(`
/// @timescale.compression(after: "7 days")
model Plain {
  id   Int      @id
  time DateTime
}
`),
    ).rejects.toThrow(/only valid together with @timescale.hypertable/);
  });

  it("requires the after argument", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
/// @timescale.compression(segmentBy: "deviceId")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/missing or non-string argument "after"/);
  });

  it("rejects an unknown segmentBy column", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
/// @timescale.compression(after: "7 days", segmentBy: "nope")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/segmentBy column "nope" is not a scalar or enum field/);
  });

  it("rejects an unknown orderBy column", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
/// @timescale.compression(after: "7 days", orderBy: "nope DESC")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/orderBy column "nope" is not a scalar or enum field/);
  });

  it("rejects a malformed orderBy direction token", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
/// @timescale.compression(after: "7 days", orderBy: "time SLOWLY")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/Invalid orderBy term/);
  });

  it("rejects an invalid after interval", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
/// @timescale.compression(after: "1 fortnight")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/Invalid interval/);
  });
});

describe("extractTimescaleSchema — space partitioning", () => {
  it("parses partitionColumn + partitions into a spacePartition config (mapped @map column)", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time", chunkInterval: "1 day", partitionColumn: "deviceId", partitions: 4)
model SensorReading {
  time     DateTime
  deviceId Int      @map("device_id")
  @@id([deviceId, time])
}
`);
    expect(result.hypertables[0]).toMatchObject({ spacePartition: { column: "device_id", partitions: 4 } });
  });

  it("requires partitionColumn and partitions together", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time", partitionColumn: "deviceId")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/must be set together/);
  });

  it("rejects an unknown partitionColumn", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time", partitionColumn: "nope", partitions: 4)
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/partitionColumn "nope" is not a scalar or enum field/);
  });

  it("rejects a non-positive partition count", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time", partitionColumn: "deviceId", partitions: 0)
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/partitions must be a positive integer/);
  });

  it("rejects a partitionColumn missing from the primary key (TimescaleDB partitioning requirement)", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time", partitionColumn: "deviceId", partitions: 4)
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([time])
}
`),
    ).rejects.toThrow(/must be included in every primary key \/ unique constraint/);
  });
});

describe("extractTimescaleSchema — chunk skipping", () => {
  it("parses chunkSkipping into a list of DB column names (single column)", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time", chunkSkipping: "eventId")
model SensorReading {
  time     DateTime
  deviceId Int
  eventId  BigInt
  @@id([deviceId, time])
}
`);
    expect(result.hypertables[0]?.chunkSkipping).toEqual(["eventId"]);
  });

  it("supports a comma-separated list and maps @map names", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time", chunkSkipping: "eventId, sensorId")
model SensorReading {
  time     DateTime
  deviceId Int
  eventId  BigInt @map("event_id")
  sensorId Int
  @@id([deviceId, time])
}
`);
    expect(result.hypertables[0]?.chunkSkipping).toEqual(["event_id", "sensorId"]);
  });

  it("omits chunkSkipping when the annotation is absent", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`);
    expect(result.hypertables[0]?.chunkSkipping).toBeUndefined();
  });

  it("rejects an unknown chunkSkipping column", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time", chunkSkipping: "nope")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/chunkSkipping column "nope" is not a scalar or enum field/);
  });

  it("rejects the time / partitioning column (it already prunes chunks)", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time", chunkSkipping: "time")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/chunkSkipping column "time" is the time\/partitioning column/);
  });

  it("rejects the hash space-partition column (it already prunes chunks)", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time", partitionColumn: "deviceId", partitions: 4, chunkSkipping: "deviceId")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/chunkSkipping column "deviceId" is the hash space-partition column/);
  });

  it("rejects a column that is also a compression segmentBy column (it would skip wrong chunks)", async () => {
    // Verified empirically: enabling chunk skipping on the segmentBy column makes the planner
    // exclude matching chunks and return wrong (empty) results, so reject it at generation time.
    await expect(
      extract(`
/// @timescale.hypertable(column: "time", chunkSkipping: "deviceId")
/// @timescale.compression(after: "7 days", segmentBy: "deviceId")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/chunkSkipping column "deviceId" is also a compression segmentBy column/);
  });
});

describe("extractTimescaleSchema — relations", () => {
  it("extracts to-one (owning, with fk) and to-many (inverse) relations", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model Reading {
  time     DateTime
  id       Int
  deviceId Int?
  device   Device? @relation(fields: [deviceId], references: [id])
  tags     Tag[]
  @@id([id, time])
}
model Device {
  id       Int       @id
  active   Boolean
  readings Reading[]
}
model Tag {
  id          Int      @id
  label       String
  readingId   Int
  readingTime DateTime
  reading     Reading  @relation(fields: [readingId, readingTime], references: [id, time])
}
`);
    expect(result.hypertables[0]?.relations).toEqual([
      { field: "device", targetModel: "Device", table: "Device", list: false, on: [{ related: "id", outer: "deviceId" }], fk: ["deviceId"] },
      { field: "tags", targetModel: "Tag", table: "Tag", list: true, on: [{ related: "readingId", outer: "id" }, { related: "readingTime", outer: "time" }] },
    ]);
    // Non-hypertable models' relations are emitted under relationsByModel (keyed by Prisma name),
    // so timeBucket where can resolve relation filters nested through them.
    expect(result.relationsByModel).toEqual({
      Device: [{ field: "readings", targetModel: "Reading", table: "Reading", list: true, on: [{ related: "deviceId", outer: "id" }] }],
      // Tag.reading has no `?`: a required to-one carries `required: true` so the runtime
      // rejects a `null` filter on it (Prisma's types reject it too).
      Tag: [{ field: "reading", targetModel: "Reading", table: "Reading", list: false, on: [{ related: "id", outer: "readingId" }, { related: "time", outer: "readingTime" }], fk: ["readingId", "readingTime"], required: true }],
    });
  });

  it("resolves @@map / @map on the related model into the join keys + column map", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time")
model Reading {
  time     DateTime
  id       Int
  deviceId Int?
  device   Device? @relation(fields: [deviceId], references: [id])
  @@id([id, time])
}
model Device {
  id       Int       @id @map("device_id")
  active   Boolean   @map("is_active")
  readings Reading[]
  @@map("devices")
}
`);
    expect(result.hypertables[0]?.relations).toEqual([
      {
        field: "device",
        targetModel: "Device",
        table: "devices",
        list: false,
        on: [{ related: "device_id", outer: "deviceId" }],
        columns: { id: "device_id", active: "is_active" },
        fk: ["deviceId"],
      },
    ]);
  });
});

describe("extractTimescaleSchema — unknown annotations and arguments fail loudly", () => {
  // Every case here used to be SILENTLY ignored (verified against the pre-fix generator),
  // leaving the user without a hypertable / policy / view column and no hint why.

  it("rejects a case-typo'd model annotation with a suggestion", async () => {
    await expect(
      extract(`
/// @timescale.hyperTable(column: "time")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}`),
    ).rejects.toThrow(/unknown annotation @timescale\.hyperTable.*did you mean @timescale\.hypertable\?/s);
  });

  it("rejects a misspelled model annotation, listing the valid names", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
/// @timescale.retension(dropAfter: "30 days")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}`),
    ).rejects.toThrow(/unknown annotation @timescale\.retension.*hypertable, retention, compression, continuousAggregate/s);
  });

  it("rejects unknown argument keys with a case suggestion", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time", chunkinterval: "1 day")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}`),
    ).rejects.toThrow(/unknown argument "chunkinterval".*did you mean "chunkInterval"\?/s);
  });

  it("rejects a case-typo'd field annotation on a cagg view", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  @@id([deviceId, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupby
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([deviceId, bucket])
}`),
    ).rejects.toThrow(/unknown annotation @timescale\.groupby.*did you mean @timescale\.groupBy\?/s);
  });

  it("rejects unknown cagg arguments (materializedonly) and unknown nested refresh keys", async () => {
    const cagg = (extraArgs: string) =>
      extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  @@id([deviceId, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time"${extraArgs})
view SensorHourly {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([bucket])
}`);
    await expect(cagg(`, materializedonly: false`)).rejects.toThrow(
      /unknown argument "materializedonly".*did you mean "materializedOnly"\?/s,
    );
    await expect(
      cagg(`, refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour", schedual: "1 hour" }`),
    ).rejects.toThrow(/unknown argument "schedual".*startOffset, endOffset, scheduleInterval/s);
  });

  it("rejects annotations that take no arguments when given any", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  @@id([deviceId, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view SensorHourly {
  bucket  DateTime /// @timescale.bucket(column: "time")
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([bucket])
}`),
    ).rejects.toThrow(/@timescale\.bucket takes no arguments/);
  });

  it("rejects field-level annotations outside a @timescale.continuousAggregate view", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time     DateTime /// @timescale.bucket
  deviceId Int
  @@id([deviceId, time])
}`),
    ).rejects.toThrow(/field-level annotations are only valid on a @timescale\.continuousAggregate view/);
  });

  it("rejects a field-level annotation used at model level with a placement hint", async () => {
    await expect(
      extract(`
/// @timescale.groupBy
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}`),
    ).rejects.toThrow(/@timescale\.groupBy is a field-level annotation/);
  });
});

describe("extractTimescaleSchema — time column must be in every PK / unique constraint", () => {
  // TimescaleDB requires ALL partitioning columns in every unique index; a time column outside the
  // PK passes generation but fails `migrate deploy` with an opaque "cannot create a unique index
  // without the column ...". Space partitions already got this guard — the time column now does too.

  it("rejects a time column missing from the primary key", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time     DateTime
  deviceId Int      @id
}`),
    ).rejects.toThrow(/column "time" must be included in every primary key \/ unique constraint.*missing from: \[deviceId\]/s);
  });

  it("rejects a time column present in @@id but missing from a @@unique", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time     DateTime
  deviceId Int
  serial   String
  @@id([deviceId, time])
  @@unique([serial])
}`),
    ).rejects.toThrow(/column "time" must be included in every primary key \/ unique constraint.*missing from: \[serial\]/s);
  });

  it("rejects a time column missing from a single-field @unique", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time     DateTime
  deviceId Int
  serial   String   @unique
  @@id([deviceId, time])
}`),
    ).rejects.toThrow(/column "time" must be included in every primary key \/ unique constraint.*missing from: \[serial\]/s);
  });

  it("reports every offending constraint at once, not just the first", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time     DateTime
  deviceId Int
  serial   String
  mac      String
  @@id([deviceId, time])
  @@unique([serial])
  @@unique([mac])
}`),
    ).rejects.toThrow(/missing from: \[serial\], \[mac\]/);
  });

  it("accepts a time column included in every constraint", async () => {
    const { hypertables } = await extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time     DateTime
  deviceId Int
  serial   String
  @@id([deviceId, time])
  @@unique([serial, time])
}`);
    expect(hypertables).toHaveLength(1);
  });
});

describe("extractTimescaleSchema — parse errors carry model/field context", () => {
  // The annotation parser is deliberately DMMF-free, so its errors ("Malformed annotation
  // argument ...") name only the offending text. In a large schema that means grepping —
  // the DMMF layer must say which model/field the bad annotation sits on.

  it("names the model for a malformed model-level annotation", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column "time")
model SensorReading {
  time     DateTime
  deviceId Int
  @@id([deviceId, time])
}`),
    ).rejects.toThrow(/on model "SensorReading".*Malformed annotation argument/s);
  });

  it("names the view field for a malformed field-level annotation", async () => {
    await expect(
      extract(`
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
  avgTemp Float    /// @timescale.aggregate(fn "avg", column: "temperature")
  @@unique([bucket])
}`),
    ).rejects.toThrow(/on "SensorHourly\.avgTemp".*Malformed annotation argument/s);
  });
});

describe("extractTimescaleSchema — enum fields are data columns", () => {
  const ENUM = `
enum Status {
  OK
  ERR
}
`;

  it("includes enum @map renames in the hypertable columns map", async () => {
    const result = await extract(`${ENUM}
/// @timescale.hypertable(column: "time")
model SensorReading {
  time   DateTime
  id     Int
  status Status @map("status_col")
  @@id([id, time])
}
`);
    expect(result.hypertables[0]?.columns).toEqual({ status: "status_col" });
  });

  it("accepts an enum compression segmentBy column and resolves its @map name", async () => {
    const result = await extract(`${ENUM}
/// @timescale.hypertable(column: "time")
/// @timescale.compression(after: "7 days", segmentBy: "status")
model SensorReading {
  time   DateTime
  id     Int
  status Status @map("status_col")
  @@id([id, time])
}
`);
    expect(result.hypertables[0]?.compression?.segmentBy).toEqual(["status_col"]);
  });

  it("rejects avg/sum on an enum aggregate column but accepts min/max/count", async () => {
    const schema = (fn: string) => `${ENUM}
/// @timescale.hypertable(column: "time")
model SensorReading {
  time   DateTime
  status Status
  @@id([status, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view SensorHourly {
  bucket DateTime /// @timescale.bucket
  agg    Status   /// @timescale.aggregate(fn: "${fn}", column: "status")
  @@unique([bucket])
}
`;
    await expect(extract(schema("avg"))).rejects.toThrow(/aggregate fn "avg" is not defined for enum column "status"/);
    await expect(extract(schema("sum"))).rejects.toThrow(/aggregate fn "sum" is not defined for enum column "status"/);
    const result = await extract(schema("max"));
    expect(result.continuousAggregates[0]?.aggregates).toEqual([{ name: "agg", fn: "max", column: "status" }]);
  });

  it("accepts an enum groupBy column on a continuous aggregate", async () => {
    const result = await extract(`${ENUM}
/// @timescale.hypertable(column: "time")
model SensorReading {
  time        DateTime
  status      Status
  temperature Float
  @@id([status, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view SensorHourly {
  bucket  DateTime /// @timescale.bucket
  status  Status   /// @timescale.groupBy
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([status, bucket])
}
`);
    expect(result.continuousAggregates[0]?.groupBy).toEqual([{ source: "status", output: "status" }]);
  });
});

describe("extractTimescaleSchema — chunkSkipping column types", () => {
  it("rejects a Float chunkSkipping column (unsupported for range calculation)", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time", chunkSkipping: "temperature")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/chunkSkipping column "temperature" has type Float; chunk skipping supports integer-like and timestamp-like columns only/);
  });

  it("rejects an enum chunkSkipping column", async () => {
    await expect(
      extract(`
enum Status {
  OK
  ERR
}

/// @timescale.hypertable(column: "time", chunkSkipping: "status")
model SensorReading {
  time     DateTime
  deviceId Int
  status   Status
  @@id([deviceId, time])
}
`),
    ).rejects.toThrow(/chunkSkipping column "status" has type Status; chunk skipping supports integer-like and timestamp-like columns only/);
  });

  it("accepts a DateTime chunkSkipping column that is not the time dimension", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time", chunkSkipping: "ingestedAt")
model SensorReading {
  time       DateTime
  deviceId   Int
  ingestedAt DateTime
  @@id([deviceId, time])
}
`);
    expect(result.hypertables[0]?.chunkSkipping).toEqual(["ingestedAt"]);
  });
});

describe("extractTimescaleSchema — every cagg view field must be annotated", () => {
  it("rejects an unannotated view field instead of silently omitting it", async () => {
    await expect(
      extract(`
/// @timescale.hypertable(column: "time")
model SensorReading {
  time        DateTime
  temperature Float
  @@id([time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view SensorHourly {
  bucket    DateTime /// @timescale.bucket
  avgTemp   Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  forgotten Float
  @@unique([bucket])
}
`),
    ).rejects.toThrow(/view field "forgotten" has no @timescale annotation/);
  });
});

describe("extractTimescaleSchema — implicit many-to-many relations", () => {
  const SCHEMA = `
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model Reading {
  time     DateTime
  id       Int
  deviceId Int?
  device   Device? @relation(fields: [deviceId], references: [id])
  @@id([id, time])
}
model Device {
  id         Int        @id
  categories Category[]
  readings   Reading[]
}
model Category {
  id      Int      @id @map("cat_id")
  name    String
  devices Device[]
}
`;

  it("extracts both sides with the hidden join table (A = alphabetically-first model, @map ids resolved)", async () => {
    // Verified empirically against Prisma's DDL: table _<relationName>, column "A" references
    // the alphabetically-first model's id, "B" the other, ids via their @map DB columns.
    const result = await extract(SCHEMA);
    expect(result.relationsByModel["Device"]).toContainEqual({
      field: "categories",
      targetModel: "Category",
      table: "Category",
      list: true,
      on: [{ related: "cat_id", outer: "id" }],
      columns: { id: "cat_id" },
      through: { table: "_CategoryToDevice", outerColumn: "B", relatedColumn: "A" },
    });
    expect(result.relationsByModel["Category"]).toContainEqual({
      field: "devices",
      targetModel: "Device",
      table: "Device",
      list: true,
      on: [{ related: "id", outer: "cat_id" }],
      through: { table: "_CategoryToDevice", outerColumn: "A", relatedColumn: "B" },
    });
  });

  it("uses the custom @relation name for the join table", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time")
model Reading {
  time DateTime
  id   Int
  @@id([id, time])
}
model Device {
  id   Int   @id
  tags Tag[] @relation("labelled")
}
model Tag {
  id      Int      @id
  devices Device[] @relation("labelled")
}
`);
    expect(result.relationsByModel["Device"]?.[0]?.through?.table).toBe("_labelled");
  });

  it("skips an implicit many-to-many self-relation (direction is ambiguous)", async () => {
    const result = await extract(`
/// @timescale.hypertable(column: "time")
model Reading {
  time DateTime
  id   Int
  @@id([id, time])
}
model Person {
  id        Int      @id
  friends   Person[] @relation("friends")
  friendOf  Person[] @relation("friends")
}
`);
    expect(result.relationsByModel["Person"] ?? []).toEqual([]);
  });
});

describe("extractTimescaleSchema — implicit m-n across schemas (multiSchema)", () => {
  it("places the join table in the alphabetically-first model's schema", async () => {
    // Probed empirically: db push on this exact shape created meta._CategoryToDevice
    // (Category's schema), matching Prisma's multiSchema docs.
    const dmmf = await getDMMF({
      datamodel: `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
  previewFeatures = ["views", "multiSchema"]
}
datasource db {
  provider = "postgresql"
  schemas = ["iot", "meta"]
}

/// @timescale.hypertable(column: "time")
model Reading {
  time DateTime
  id   Int
  @@id([id, time])
  @@schema("iot")
}
model Device {
  id         Int        @id
  categories Category[]
  @@schema("iot")
}
model Category {
  id      Int      @id
  devices Device[]
  @@schema("meta")
}
`,
    });
    const result = extractTimescaleSchema(dmmf);
    // From Device (name > Category): Device is the "B" side; the join table sits in meta.
    expect(result.relationsByModel["Device"]?.[0]?.through).toEqual({
      table: "_CategoryToDevice",
      schema: "meta",
      outerColumn: "B",
      relatedColumn: "A",
    });
    // From Category (the "A" side): same table, same schema, columns flipped.
    expect(result.relationsByModel["Category"]?.[0]?.through).toEqual({
      table: "_CategoryToDevice",
      schema: "meta",
      outerColumn: "A",
      relatedColumn: "B",
    });
  });
});
