import { getDMMF } from "@prisma/internals";
import ts from "typescript";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractTimescaleSchema, type TimescaleSchema } from "../../src/generator/dmmf.js";
import {
  emitMigrations,
  objectsMigrationName,
  maxObjectsSequence,
  parseGeneratorState,
  EXTENSION_MIGRATION,
  OBJECTS_MIGRATION_PREFIX,
  type GeneratorState,
} from "../../src/generator/emit-migrations.js";
import { emitTypes } from "../../src/generator/emit-types.js";

const SCHEMA = `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
  previewFeatures = ["views"]
}
datasource db {
  provider = "postgresql"
}

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
`;

async function loadSchema(): Promise<TimescaleSchema> {
  return extractTimescaleSchema(await getDMMF({ datamodel: SCHEMA }));
}

/** Full strict type-check of a generated TS source string; returns diagnostic messages. */
function typeCheck(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "ts-emit-"));
  const file = join(dir, "generated.ts");
  writeFileSync(file, source, "utf8");
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("emitMigrations (append-only versioned objects migrations)", () => {
  const V1 = `${objectsMigrationName(1)}/migration.sql`;
  const V2 = `${objectsMigrationName(2)}/migration.sql`;

  it("emits nothing when there are no timescale objects and no history", () => {
    expect(emitMigrations({ hypertables: [], continuousAggregates: [], relationsByModel: {} })).toEqual({ files: {} });
  });

  it("first run: emits the extension migration and objects v0001, plus the state to persist", async () => {
    const { files, nextState } = emitMigrations(await loadSchema());
    expect(Object.keys(files).sort()).toEqual([`${EXTENSION_MIGRATION}/migration.sql`, V1]);
    // Folder names guarantee deploy order: 0000… sorts before any real timestamp; 9999… after.
    expect(EXTENSION_MIGRATION < "20260101000000_x").toBe(true);
    expect(objectsMigrationName(1) > "20260101000000_x").toBe(true);
    // Versions order lexicographically, and after the pre-v1 fixed-name migration.
    expect(objectsMigrationName(2) > objectsMigrationName(1)).toBe(true);
    expect(objectsMigrationName(1) > OBJECTS_MIGRATION_PREFIX).toBe(true);
    expect(objectsMigrationName(10) > objectsMigrationName(9)).toBe(true); // zero-padding
    expect(nextState?.sequence).toBe(1);
  });

  it("unchanged schema: regeneration is a no-op (no files, no state write)", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const again = emitMigrations(schema, first.nextState);
    expect(again.files).toEqual({});
    expect(again.nextState).toBeUndefined();
  });

  it("changed schema: appends the NEXT version instead of rewriting v0001", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const grown: typeof schema = {
      ...schema,
      hypertables: [...schema.hypertables, { table: "EventLog", column: "at", chunkInterval: "1 day" }],
    };
    // The extension migration is already on disk by now, so only v0002 is written.
    const second = emitMigrations(grown, first.nextState, 1, true);
    // v0001 is never touched again.
    expect(Object.keys(second.files)).toEqual([V2]);
    expect(second.files[V2]).toContain(`'"EventLog"'`);
    // The new version re-asserts the FULL state (idempotent), not just the delta.
    expect(second.files[V2]).toContain(`'"SensorReading"'`);
    expect(second.nextState?.sequence).toBe(2);
  });

  // Rewriting an applied migration changes the checksum Prisma recorded for it, and
  // `migrate dev` then rejects it as "modified after it was applied". The extension migration
  // has a fixed name, so once it is on disk it is history and must be left alone.
  it("never rewrites the extension migration once it exists on disk", async () => {
    const { files } = emitMigrations(await loadSchema(), undefined, 0, true);
    expect(Object.keys(files)).toEqual([V1]);
  });

  // Issue #129: Prisma runs migrations with `search_path` set to the datasource schema alone,
  // so unqualified `create_hypertable` / `by_range` / `time_bucket` are unresolvable when the
  // project's tables live outside `public`. Every emitted block must extend the search path
  // with the schema TimescaleDB was installed into.
  it("every emitted block resolves TimescaleDB's schema onto the search path", async () => {
    const schema = await loadSchema();
    const withPolicies: typeof schema = {
      ...schema,
      hypertables: schema.hypertables.map((h) => ({
        ...h,
        retention: { dropAfter: "30 days" as const },
        compression: { after: "7 days" as const, segmentBy: ["deviceId"] },
        chunkSkipping: ["temperature"],
      })),
    };
    // A second version with everything removed exercises the removal blocks too.
    const first = emitMigrations(withPolicies);
    const second = emitMigrations(
      { ...schema, hypertables: [], continuousAggregates: [] },
      first.nextState,
      1,
      true,
    );

    for (const sql of [first.files[V1], second.files[V2]]) {
      expect(sql).toBeDefined();
      const blocks = (sql as string).split("\nDO $$").length - 1;
      expect(blocks).toBeGreaterThan(0);
      const resolves = (sql as string).split("INTO ts_schema").length - 1;
      expect(resolves).toBe(blocks);
    }
  });

  it("matches the reset-safe extension SQL", async () => {
    const { files } = emitMigrations(await loadSchema());
    expect(files[`${EXTENSION_MIGRATION}/migration.sql`]).toMatchInlineSnapshot(`
      "-- AUTO-GENERATED by prisma-extension-timescaledb. Do not edit by hand.
      -- TimescaleDB extension setup. Standalone & leading so it runs before any table or
      -- hypertable DDL (CLAUDE.md constraint 1).
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN RETURN; END IF;
        IF to_regnamespace('public') IS NOT NULL THEN
          EXECUTE 'CREATE EXTENSION timescaledb WITH SCHEMA public CASCADE';
        ELSE
          EXECUTE 'CREATE EXTENSION timescaledb CASCADE';
        END IF;
      END $$;
      "
    `);
  });

  it("matches the guarded reset-safe objects SQL (hypertable then cagg, no casts)", async () => {
    const { files } = emitMigrations(await loadSchema());
    const objects = files[V1]!;
    expect(objects).not.toContain("::regclass");
    expect(objects).not.toContain("::name");
    expect(objects.indexOf("create_hypertable")).toBeLessThan(objects.indexOf("CREATE MATERIALIZED VIEW"));
    expect(objects).toMatchInlineSnapshot(`
      "-- AUTO-GENERATED by prisma-extension-timescaledb. Do not edit by hand.
      -- TimescaleDB objects, state v1. Sorts last so the tables Prisma created in its own
      -- migrations already exist. Never rewritten: a schema change appends the next version instead.
      -- Every block is idempotent and guarded (skips if its table was dropped later), so a full
      -- \`migrate reset\` replay of v1..v1 converges on exactly this state (constraint 3).

      -- Hypertable: SensorReading
      DO $$
      DECLARE ts_schema text;
      BEGIN
        IF to_regclass('"SensorReading"') IS NULL THEN RAISE WARNING 'prisma-extension-timescaledb: relation % does not exist; skipping (table dropped by a later migration, or its CREATE TABLE migration is missing)', '"SensorReading"'; RETURN; END IF;
        SELECT n.nspname INTO ts_schema
          FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
         WHERE e.extname = 'timescaledb';
        PERFORM set_config('search_path', concat_ws(', ', nullif(current_setting('search_path'), ''), quote_ident(ts_schema)), true);
        PERFORM create_hypertable(
          '"SensorReading"',
          by_range('time', INTERVAL '1 day'),
          if_not_exists          => TRUE,
          migrate_data           => TRUE,
          create_default_indexes => FALSE
        );
        PERFORM set_partitioning_interval('"SensorReading"', INTERVAL '1 day');
      END $$;

      -- Continuous aggregate: SensorHourly
      DO $$
      DECLARE ts_schema text;
      BEGIN
        IF to_regclass('"SensorReading"') IS NULL THEN RAISE WARNING 'prisma-extension-timescaledb: relation % does not exist; skipping (table dropped by a later migration, or its CREATE TABLE migration is missing)', '"SensorReading"'; RETURN; END IF;
        SELECT n.nspname INTO ts_schema
          FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
         WHERE e.extname = 'timescaledb';
        PERFORM set_config('search_path', concat_ws(', ', nullif(current_setting('search_path'), ''), quote_ident(ts_schema)), true);
        CREATE MATERIALIZED VIEW IF NOT EXISTS "SensorHourly"
          WITH (timescaledb.continuous) AS
        SELECT
          time_bucket('1 hour', "time") AS "bucket",
          "deviceId" AS "deviceId",
          avg("temperature") AS "avgTemp",
          max("temperature") AS "maxTemp"
        FROM "SensorReading"
        GROUP BY time_bucket('1 hour', "time"), "deviceId"
        WITH NO DATA;
        PERFORM add_continuous_aggregate_policy('"SensorHourly"',
          start_offset      => INTERVAL '1 month',
          end_offset        => INTERVAL '1 hour',
          schedule_interval => INTERVAL '1 hour',
          if_not_exists     => TRUE
        );
      END $$;
      "
    `);
  });

  const withAnnotations = async (annotations: string, fields = "") => {
    const dmmf = await getDMMF({
      datamodel: `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
  previewFeatures = ["views"]
}
datasource db {
  provider = "postgresql"
}

${annotations}
model SensorReading {
  time     DateTime
  deviceId Int
${fields}  @@id([deviceId, time])
}
`,
    });
    return extractTimescaleSchema(dmmf);
  };

  it("emits the guarded retention policy after its hypertable", async () => {
    const schema = await withAnnotations(
      `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")\n/// @timescale.retention(dropAfter: "30 days")`,
    );
    const objects = emitMigrations(schema).files[V1]!;
    expect(objects).toContain(
      `PERFORM add_retention_policy('"SensorReading"', drop_after => INTERVAL '30 days', if_not_exists => TRUE);`,
    );
    expect(objects).toContain(`IF to_regclass('"SensorReading"') IS NULL THEN RAISE WARNING`);
    expect(objects).not.toContain("::regclass");
    expect(objects.indexOf("create_hypertable")).toBeLessThan(objects.indexOf("add_retention_policy"));
  });

  it("emits the guarded compression policy (columnstore + CALL) after its hypertable", async () => {
    const schema = await withAnnotations(
      `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")\n/// @timescale.compression(after: "7 days", segmentBy: "deviceId", orderBy: "time DESC")`,
    );
    const objects = emitMigrations(schema).files[V1]!;
    expect(objects).toContain("timescaledb.enable_columnstore = true");
    expect(objects).toContain(`timescaledb.segmentby = '"deviceId"'`);
    expect(objects).toContain(`timescaledb.orderby = '"time" DESC'`);
    expect(objects).toContain(
      `CALL add_columnstore_policy('"SensorReading"', after => INTERVAL '7 days', if_not_exists => TRUE);`,
    );
    expect(objects).not.toContain("::regclass");
    expect(objects.indexOf("create_hypertable")).toBeLessThan(objects.indexOf("add_columnstore_policy"));
  });

  it("emits guarded chunk skipping (DO block + enable_chunk_skipping) after its hypertable", async () => {
    const schema = await withAnnotations(
      `/// @timescale.hypertable(column: "time", chunkInterval: "1 day", chunkSkipping: "eventId")`,
      "  eventId  BigInt\n",
    );
    const objects = emitMigrations(schema).files[V1]!;
    expect(objects).toContain("SET LOCAL timescaledb.enable_chunk_skipping = on;");
    expect(objects).toContain(`PERFORM enable_chunk_skipping('"SensorReading"', 'eventId', if_not_exists => TRUE);`);
    expect(objects).not.toContain("::regclass");
    expect(objects.indexOf("create_hypertable")).toBeLessThan(objects.indexOf("enable_chunk_skipping"));
  });

  it("orders a hierarchical cagg after the source cagg it depends on (topological, not alphabetical)", async () => {
    const dmmf = await getDMMF({
      datamodel: `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
  previewFeatures = ["views"]
}
datasource db {
  provider = "postgresql"
}

/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  temperature Float
  @@id([time])
}

/// @timescale.continuousAggregate(source: "Zinner", bucket: "1 day", timeColumn: "bucket")
view Aouter {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "avgTemp")
  @@unique([bucket])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view Zinner {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([bucket])
}
`,
    });
    const objects = emitMigrations(extractTimescaleSchema(dmmf)).files[V1]!;
    const inner = objects.indexOf(`CREATE MATERIALIZED VIEW IF NOT EXISTS "Zinner"`);
    const outer = objects.indexOf(`CREATE MATERIALIZED VIEW IF NOT EXISTS "Aouter"`);
    expect(inner).toBeGreaterThanOrEqual(0);
    expect(outer).toBeGreaterThanOrEqual(0);
    expect(inner).toBeLessThan(outer);
  });

  it("a removed cagg is dropped (DROP MATERIALIZED VIEW, constraint 4) in the next version", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const withoutCagg: typeof schema = { ...schema, continuousAggregates: [] };
    const second = emitMigrations(withoutCagg, first.nextState);
    const v2 = second.files[V2]!;
    expect(v2).toContain(`DROP MATERIALIZED VIEW IF EXISTS "SensorHourly";`);
    expect(v2).not.toContain("DROP VIEW ");
    // Removal comes before the re-asserted creates.
    expect(v2.indexOf("DROP MATERIALIZED VIEW")).toBeLessThan(v2.indexOf("create_hypertable"));
  });

  it("a removed retention/compression policy is removed in the next version; hypertable removal warns", async () => {
    const base = await withAnnotations(
      `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")\n/// @timescale.retention(dropAfter: "30 days")\n/// @timescale.compression(after: "7 days")`,
    );
    const first = emitMigrations(base);
    const bare = await withAnnotations(`/// @timescale.hypertable(column: "time", chunkInterval: "1 day")`);
    const second = emitMigrations(bare, first.nextState);
    const v2 = second.files[V2]!;
    expect(v2).toContain(`PERFORM remove_retention_policy('"SensorReading"', if_exists => TRUE);`);
    expect(v2).toContain(`CALL remove_columnstore_policy('"SensorReading"', if_exists => TRUE);`);

    // Removing the hypertable annotation entirely: policies removed, un-hypertable impossible.
    const gone = extractTimescaleSchema(
      await getDMMF({
        datamodel: `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
  previewFeatures = ["views"]
}
datasource db {
  provider = "postgresql"
}
model Unrelated {
  id Int @id
}
`,
      }),
    );
    const third = emitMigrations(gone, second.nextState);
    const v3 = third.files[`${objectsMigrationName(3)}/migration.sql`]!;
    expect(v3).toContain("TimescaleDB cannot convert a hypertable back");
    expect(third.nextState?.sequence).toBe(3);
  });

  it("relation-only changes do not spawn a new migration (state excludes relations)", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const withRelations: typeof schema = {
      ...schema,
      hypertables: schema.hypertables.map((h) => ({
        ...h,
        relations: [{ field: "x", table: "X", list: false, on: [{ related: "id", outer: "xId" }] }],
      })),
      relationsByModel: { X: [{ field: "readings", table: "SensorReading", list: true, on: [{ related: "xId", outer: "id" }] }] },
    };
    const again = emitMigrations(withRelations, first.nextState);
    expect(again.files).toEqual({});
  });

  it("state round-trips through JSON (what the generator persists and reloads)", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const reloaded = JSON.parse(JSON.stringify(first.nextState)) as GeneratorState;
    expect(emitMigrations(schema, reloaded).files).toEqual({});
  });
});

describe("emitTypes", () => {
  it("emits a type module that type-checks under strict mode", async () => {
    const source = emitTypes(await loadSchema())["index.ts"]!;
    expect(typeCheck(source)).toEqual([]);
  });

  it("matches the generated type module", async () => {
    const source = emitTypes(await loadSchema())["index.ts"]!;
    expect(source).toMatchInlineSnapshot(`
      "// AUTO-GENERATED by prisma-extension-timescaledb. Do not edit by hand.

      /**
       * Branded time type for hypertable partition columns. Range-bounded query helpers can require
       * this so callers can't forget the time bound (SPEC §3).
       */
      export type HypertableTime = Date & { readonly __timescaleTime: unique symbol };

      /** Runtime description of every hypertable and continuous aggregate in the schema. */
      export const registry = {
        "hypertables": [
          {
            "table": "SensorReading",
            "column": "time",
            "chunkInterval": "1 day"
          }
        ],
        "continuousAggregates": [
          {
            "name": "SensorHourly",
            "source": "SensorReading",
            "bucket": "1 hour",
            "timeColumn": "time",
            "bucketColumn": "bucket",
            "groupBy": [
              {
                "source": "deviceId",
                "output": "deviceId"
              }
            ],
            "aggregates": [
              {
                "name": "avgTemp",
                "fn": "avg",
                "column": "temperature"
              },
              {
                "name": "maxTemp",
                "fn": "max",
                "column": "temperature"
              }
            ],
            "refresh": {
              "startOffset": "1 month",
              "endOffset": "1 hour",
              "scheduleInterval": "1 hour"
            }
          }
        ]
      } as const;

      /** The shape of {@link registry}, for typing the client extension. */
      export type TimescaleRegistry = typeof registry;
      "
    `);
  });

  it("emits relationsByModel for related (non-hypertable) models, and it still type-checks as `as const`", async () => {
    const dmmf = await getDMMF({
      datamodel: `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
  previewFeatures = ["views"]
}
datasource db {
  provider = "postgresql"
}

/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model Reading {
  time     DateTime
  id       Int
  deviceId Int?
  device   Device? @relation(fields: [deviceId], references: [id])
  @@id([id, time])
}
model Device {
  id       Int       @id
  active   Boolean
  readings Reading[]
}
`,
    });
    const source = emitTypes(extractTimescaleSchema(dmmf))["index.ts"]!;
    expect(source).toContain(`"relationsByModel"`);
    expect(source).toContain(`"targetModel": "Reading"`); // Device.readings -> Reading, for nesting
    expect(typeCheck(source)).toEqual([]);
  });
});

describe("emitMigrations — review follow-up behaviors", () => {
  const V2 = `${objectsMigrationName(2)}/migration.sql`;

  it("registry-only changes (model rename, @map columns) do not spawn a migration", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const renamed: typeof schema = {
      ...schema,
      hypertables: schema.hypertables.map((h) => ({ ...h, model: "RenamedModel", columns: { deviceId: "device_id" } })),
      continuousAggregates: schema.continuousAggregates.map((c) => ({ ...c, model: "RenamedView" })),
    };
    expect(emitMigrations(renamed, first.nextState).files).toEqual({});
  });

  it("a CHANGED cagg is dropped and recreated; its dependents are dropped first", async () => {
    const dmmf = await getDMMF({
      datamodel: `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
  previewFeatures = ["views"]
}
datasource db {
  provider = "postgresql"
}

/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  temperature Float
  @@id([time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time")
view Hourly {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  @@unique([bucket])
}

/// @timescale.continuousAggregate(source: "Hourly", bucket: "1 day", timeColumn: "bucket")
view Daily {
  bucket  DateTime /// @timescale.bucket
  avgTemp Float    /// @timescale.aggregate(fn: "avg", column: "avgTemp")
  @@unique([bucket])
}
`,
    });
    const schema = extractTimescaleSchema(dmmf);
    const first = emitMigrations(schema);
    // Change the PARENT cagg's bucket: it and its dependent Daily must be dropped, child first.
    const changed: typeof schema = {
      ...schema,
      continuousAggregates: schema.continuousAggregates.map((c) =>
        c.name === "Hourly" ? { ...c, bucket: "2 hours" as (typeof c)["bucket"] } : c,
      ),
    };
    const v2 = emitMigrations(changed, first.nextState).files[V2]!;
    const dropDaily = v2.indexOf(`DROP MATERIALIZED VIEW IF EXISTS "Daily";`);
    const dropHourly = v2.indexOf(`DROP MATERIALIZED VIEW IF EXISTS "Hourly";`);
    expect(dropDaily).toBeGreaterThanOrEqual(0);
    expect(dropHourly).toBeGreaterThanOrEqual(0);
    expect(dropDaily).toBeLessThan(dropHourly); // child before parent
    // Both are recreated after the drops (creates section re-asserts the full state),
    // the dependent included — dropping Daily without recreating it would lose the view.
    expect(v2.indexOf(`CREATE MATERIALIZED VIEW IF NOT EXISTS "Hourly"`)).toBeGreaterThan(dropHourly);
    expect(v2.indexOf(`CREATE MATERIALIZED VIEW IF NOT EXISTS "Daily"`)).toBeGreaterThan(dropHourly);
    expect(v2).toContain("2 hours");
  });

  it("a changed or removed refresh policy on an UNCHANGED cagg removes the old policy without dropping the view", async () => {
    const schema = await loadSchema(); // SensorHourly has a refresh policy
    const first = emitMigrations(schema);
    const withoutRefresh: typeof schema = {
      ...schema,
      continuousAggregates: schema.continuousAggregates.map(({ refresh: _refresh, ...rest }) => rest),
    };
    const v2 = emitMigrations(withoutRefresh, first.nextState).files[V2]!;
    expect(v2).toContain(`PERFORM remove_continuous_aggregate_policy('"SensorHourly"', if_not_exists => TRUE);`);
    expect(v2).not.toContain(`DROP MATERIALIZED VIEW IF EXISTS "SensorHourly"`);
  });

  it("a changed retention policy is removed before the new one is re-added", async () => {
    const dmmf = await getDMMF({
      datamodel: `
generator client {
  provider = "prisma-client"
  output = "../generated/prisma"
  previewFeatures = ["views"]
}
datasource db {
  provider = "postgresql"
}

/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.retention(dropAfter: "30 days")
model SensorReading {
  time DateTime
  @@id([time])
}
`,
    });
    const schema = extractTimescaleSchema(dmmf);
    const first = emitMigrations(schema);
    const changed: typeof schema = {
      ...schema,
      hypertables: schema.hypertables.map((h) => ({
        ...h,
        retention: { dropAfter: "60 days" as NonNullable<(typeof h)["retention"]>["dropAfter"] },
      })),
    };
    const v2 = emitMigrations(changed, first.nextState).files[V2]!;
    const remove = v2.indexOf(`remove_retention_policy('"SensorReading"', if_exists => TRUE)`);
    const add = v2.indexOf(`add_retention_policy('"SensorReading"', drop_after => INTERVAL '60 days'`);
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(remove);
  });

  it("the guarded hypertable block re-asserts the chunk interval (converges after a change)", async () => {
    const schema = await loadSchema();
    const v1 = emitMigrations(schema).files[`${objectsMigrationName(1)}/migration.sql`]!;
    expect(v1).toContain(`PERFORM set_partitioning_interval('"SensorReading"', INTERVAL '1 day');`);
  });

  it("a lost state file never reuses an existing version number (recovery appends)", async () => {
    const schema = await loadSchema();
    // No previous state, but v0001..v0003 already exist on disk.
    const { files, nextState } = emitMigrations(schema, undefined, 3);
    expect(Object.keys(files)).toContain(`${objectsMigrationName(4)}/migration.sql`);
    expect(nextState?.sequence).toBe(4);
    // Recovery has no previous state to diff against: full re-assert, no removals.
    expect(files[`${objectsMigrationName(4)}/migration.sql`]).not.toContain("DROP MATERIALIZED VIEW");
  });

  it("parseGeneratorState rejects malformed shapes instead of passing them through", async () => {
    const schema = await loadSchema();
    const good = emitMigrations(schema).nextState!;
    expect(parseGeneratorState(JSON.stringify(good))).toEqual(good);
    expect(parseGeneratorState(undefined)).toBeUndefined();
    expect(parseGeneratorState("not json")).toBeUndefined();
    expect(parseGeneratorState(JSON.stringify({ version: 1, sequence: 1 }))).toBeUndefined(); // no state
    expect(
      parseGeneratorState(JSON.stringify({ version: 1, sequence: 1, state: { hypertables: [] } })), // no caggs array
    ).toBeUndefined();
    expect(
      parseGeneratorState(JSON.stringify({ version: 2, sequence: 1, state: { hypertables: [], continuousAggregates: [] } })),
    ).toBeUndefined(); // unknown version
    expect(parseGeneratorState(JSON.stringify({ version: 1, sequence: 0, state: { hypertables: [], continuousAggregates: [] } }))).toBeUndefined();
  });

  it("maxObjectsSequence reads the highest versioned folder and ignores everything else", () => {
    expect(maxObjectsSequence([])).toBe(0);
    expect(
      maxObjectsSequence([
        "20260101000000_init",
        "00000000000000_timescaledb_extension",
        "99999999999999_timescaledb_objects", // pre-v1 legacy: not versioned
        "99999999999999_timescaledb_objects_v0001",
        "99999999999999_timescaledb_objects_v0012",
        ".prisma-extension-timescaledb.json",
      ]),
    ).toBe(12);
  });
});

describe("emitMigrations — second-round review behaviors", () => {
  it("rejects state files with malformed ENTRIES, not just malformed containers", () => {
    const base = { version: 1, sequence: 1 };
    expect(
      parseGeneratorState(JSON.stringify({ ...base, state: { hypertables: [null], continuousAggregates: [] } })),
    ).toBeUndefined();
    expect(
      parseGeneratorState(JSON.stringify({ ...base, state: { hypertables: [{ table: "T" }], continuousAggregates: [] } })),
    ).toBeUndefined(); // hypertable entry missing column
    expect(
      parseGeneratorState(
        JSON.stringify({ ...base, state: { hypertables: [], continuousAggregates: [{ name: "V", source: "T" }] } }),
      ),
    ).toBeUndefined(); // cagg entry missing aggregates
  });

  it("a legacy state file carrying registry-only fields does not read as a change", async () => {
    const schema = await loadSchema();
    const { nextState } = emitMigrations(schema);
    // Simulate a state persisted before canonicalState stripped model/columns.
    const legacy: GeneratorState = JSON.parse(JSON.stringify(nextState)) as GeneratorState;
    (legacy.state.hypertables[0] as { model?: string; columns?: Record<string, string> }).model = "SensorReading";
    (legacy.state.hypertables[0] as { model?: string; columns?: Record<string, string> }).columns = { deviceId: "device_id" };
    (legacy.state.continuousAggregates[0] as { model?: string }).model = "SensorHourly";
    expect(emitMigrations(schema, legacy).files).toEqual({});
  });
});
