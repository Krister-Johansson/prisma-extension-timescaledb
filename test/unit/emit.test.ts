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
  MissingMigrationError,
  NewerStateFileError,
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
    const again = emitMigrations(schema, first.nextState, 1, true);
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

  // A project can lose the extension migration folder without its objects changing: deleted by
  // hand, dropped in a merge, half-removed during a recovery. Without it every objects migration
  // fails on a fresh database, so the unchanged-state no-op must still restore it.
  it("re-emits a missing extension migration even when the state is unchanged", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const again = emitMigrations(schema, first.nextState, 1, false);
    expect(Object.keys(again.files)).toEqual([`${EXTENSION_MIGRATION}/migration.sql`]);
    expect(again.nextState).toBeUndefined(); // no new objects version, nothing changed
  });

  // ...but a schema that declares no timescale objects has no use for the extension.
  it("emits no extension migration for a schema with no timescale objects", () => {
    const bare = { hypertables: [], continuousAggregates: [], relationsByModel: {} };
    expect(emitMigrations(bare, undefined, 0, false)).toEqual({ files: {} });
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
        ELSIF current_schema() IS NOT NULL THEN
          EXECUTE 'CREATE EXTENSION timescaledb CASCADE';
        ELSE
          RAISE EXCEPTION 'prisma-extension-timescaledb: cannot install the timescaledb extension. No schema on the search path (%) exists, and this migration runs before the one that creates it. Create the schema first, or install the extension yourself with CREATE EXTENSION timescaledb.', current_setting('search_path');
        END IF;
      EXCEPTION
        -- Another session installed it between the check above and the CREATE.
        WHEN duplicate_object OR unique_violation THEN NULL;
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
    const again = emitMigrations(withRelations, first.nextState, 1, true);
    expect(again.files).toEqual({});
  });

  it("state round-trips through JSON (what the generator persists and reloads)", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const reloaded = JSON.parse(JSON.stringify(first.nextState)) as GeneratorState;
    expect(emitMigrations(schema, reloaded, 1, true).files).toEqual({});
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
    expect(emitMigrations(renamed, first.nextState, 1, true).files).toEqual({});
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
    // A version above 1 is not "unknown shape": it is a newer release's file (see the #160 cases).
    expect(() =>
      parseGeneratorState(JSON.stringify({ version: 2, sequence: 1, state: { hypertables: [], continuousAggregates: [] } })),
    ).toThrow(NewerStateFileError);
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
    expect(emitMigrations(schema, legacy, 1, true).files).toEqual({});
  });
});

// Issue #160: the state file and the migrations folder can disagree, and a state file can come
// from a release newer than the one running. Neither may leave the project stuck.
describe("emitMigrations state-file gaps (issue #160)", () => {
  const V2 = `${objectsMigrationName(2)}/migration.sql`;

  // The state file records `sequence` as the latest emitted objects migration. When that folder
  // is gone (an undeployed migration a developer deleted to redo it, or a folder lost in a merge)
  // the unchanged-state no-op used to win, and every later generate emitted nothing.
  it("re-emits the full state as the next version when the latest objects migration is missing", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema); // state file says v0001
    const healed = emitMigrations(schema, first.nextState, 0, true, false); // ...but v0001 is not on disk
    expect(Object.keys(healed.files)).toEqual([V2]);
    expect(healed.files[V2]).toContain(`'"SensorReading"'`);
    expect(healed.files[V2]).toContain(`"SensorHourly"`);
    expect(healed.nextState?.sequence).toBe(2);
    expect(healed.nextState?.state).toEqual(first.nextState?.state);
  });

  it("the healed version never reuses a number that is still on disk", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    // State file at v0001 with its folder gone, while a stray v0003 (another branch) exists.
    const healed = emitMigrations(schema, first.nextState, 3, true, false);
    expect(Object.keys(healed.files)).toEqual([`${objectsMigrationName(4)}/migration.sql`]);
    expect(healed.nextState?.sequence).toBe(4);
  });

  // The state file records the state the latest migration diffed against, so the lost
  // migration can be rebuilt exactly. A first run has nothing before it: an empty base, never
  // an absent field, since absence marks a file from an older release.
  it("records the state the latest migration diffed against", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    expect(first.nextState?.previous).toEqual({ hypertables: [], continuousAggregates: [] });
    const withoutCagg: typeof schema = { ...schema, continuousAggregates: [] };
    const second = emitMigrations(withoutCagg, first.nextState, 1, true);
    expect(second.nextState?.previous).toEqual(first.nextState?.state);
    expect(second.nextState?.state.continuousAggregates).toEqual([]);
    // Regenerating an unchanged schema stays a no-op with the field present.
    expect(emitMigrations(withoutCagg, second.nextState, 2, true)).toEqual({ files: {} });
  });

  // v1 creates cagg A; an undeployed v2 replaces its definition with B and is then deleted. The
  // saved state says B, so a diff against it would emit no drop, and the guarded create would
  // leave A in place on a replay. The rebuilt v3 must carry v2's drop.
  it("a lost migration that replaced a cagg definition is rebuilt with its drop", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const replaced: typeof schema = {
      ...schema,
      continuousAggregates: schema.continuousAggregates.map((c) => ({ ...c, bucket: "2 hours" as typeof c.bucket })),
    };
    const second = emitMigrations(replaced, first.nextState, 1, true);
    expect(second.files[V2]).toContain(`DROP MATERIALIZED VIEW IF EXISTS "SensorHourly"`);
    const healed = emitMigrations(replaced, second.nextState, 1, true, false);
    const v3 = `${objectsMigrationName(3)}/migration.sql`;
    expect(Object.keys(healed.files)).toEqual([v3]);
    expect(healed.files[v3]).toContain(`DROP MATERIALIZED VIEW IF EXISTS "SensorHourly"`);
    expect(healed.files[v3]).toContain(`time_bucket('2 hours'`);
    // The rebuilt version diffed against the same base, so the record carries forward.
    expect(healed.nextState?.previous).toEqual(second.nextState?.previous);
    expect(healed.nextState?.sequence).toBe(3);
  });

  it("a lost migration is rebuilt together with any schema change made since", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const replaced: typeof schema = {
      ...schema,
      continuousAggregates: schema.continuousAggregates.map((c) => ({ ...c, bucket: "2 hours" as typeof c.bucket })),
    };
    const second = emitMigrations(replaced, first.nextState, 1, true);
    // v2 is lost, and the cagg has been removed from the schema since.
    const withoutCagg: typeof schema = { ...schema, continuousAggregates: [] };
    const healed = emitMigrations(withoutCagg, second.nextState, 1, true, false);
    const v3 = healed.files[`${objectsMigrationName(3)}/migration.sql`]!;
    expect(v3).toContain(`DROP MATERIALIZED VIEW IF EXISTS "SensorHourly"`);
    expect(v3).not.toContain("CREATE MATERIALIZED VIEW");
    expect(healed.nextState?.state.continuousAggregates).toEqual([]);
  });

  // Review finding on #170: a healed v0002 for a lost v0001 used to leave `previous` out, so
  // deleting v0002 as well hit the older-release throw. The same held for a recovery from a
  // lost state file. Both have an empty base and must heal again.
  it("a rebuilt migration with nothing before it can itself be rebuilt", async () => {
    const schema = await loadSchema();
    const first = emitMigrations(schema);
    const healedOnce = emitMigrations(schema, first.nextState, 0, true, false); // v0001 lost, v0002 written
    expect(healedOnce.nextState?.previous).toEqual({ hypertables: [], continuousAggregates: [] });
    const healedTwice = emitMigrations(schema, healedOnce.nextState, 0, true, false); // v0002 lost too
    expect(Object.keys(healedTwice.files)).toEqual([`${objectsMigrationName(3)}/migration.sql`]);
    expect(healedTwice.nextState?.sequence).toBe(3);

    const recovered = emitMigrations(schema, undefined, 3); // lost state file, v0004 written
    expect(recovered.nextState?.previous).toEqual({ hypertables: [], continuousAggregates: [] });
    const healedAfterRecovery = emitMigrations(schema, recovered.nextState, 3, true, false); // v0004 lost
    expect(Object.keys(healedAfterRecovery.files)).toEqual([`${objectsMigrationName(5)}/migration.sql`]);
  });

  // A state file written before the `previous` field existed cannot rebuild a lost migration
  // beyond v0001. A healed version without its removals would leave old objects in place, so
  // the generator stops and says how to recover.
  it("throws for a lost migration beyond v0001 when the state file does not record the previous state", async () => {
    const schema = await loadSchema();
    const previous = { version: 1 as const, sequence: 2, state: emitMigrations(schema).nextState!.state };
    expect(() => emitMigrations(schema, previous, 1, true, false)).toThrow(MissingMigrationError);
    expect(() => emitMigrations(schema, previous, 1, true, false)).toThrow(/v0002 is missing/);
    expect(() => emitMigrations(schema, previous, 1, true, false)).toThrow(/Restore the folder/);
    // The same file with its folder present is business as usual.
    expect(emitMigrations(schema, previous, 2, true, true)).toEqual({ files: {} });
  });

  // Nothing before it and nothing in it: an empty migration would only record a version that
  // does nothing.
  it("an empty state whose lost migration also had nothing before it emits nothing", () => {
    const bare = { hypertables: [], continuousAggregates: [], relationsByModel: {} };
    const empty = { hypertables: [], continuousAggregates: [] };
    const previous = { version: 1 as const, sequence: 2, state: empty, previous: empty };
    expect(emitMigrations(bare, previous, 1, true, false)).toEqual({ files: {} });
  });

  it("parseGeneratorState accepts a well-formed previous state and rejects a malformed one", async () => {
    const schema = await loadSchema();
    const good = emitMigrations(schema).nextState!;
    const withPrevious = { ...good, previous: good.state };
    expect(parseGeneratorState(JSON.stringify(withPrevious))).toEqual(withPrevious);
    expect(parseGeneratorState(JSON.stringify({ ...good, previous: null }))).toBeUndefined();
    expect(parseGeneratorState(JSON.stringify({ ...good, previous: { hypertables: [] } }))).toBeUndefined();
    expect(
      parseGeneratorState(JSON.stringify({ ...good, previous: { hypertables: [{ table: "T" }], continuousAggregates: [] } })),
    ).toBeUndefined();
  });

  it("the latest-folder flag means nothing without a previous state", async () => {
    const schema = await loadSchema();
    const flagged = emitMigrations(schema, undefined, 0, false, false);
    expect(flagged).toEqual(emitMigrations(schema));
  });

  // A file written by a newer release used to parse as "unreadable", which emitted a full
  // re-assert migration and rewrote the file as version 1. It must stop the generator instead.
  it("parseGeneratorState throws a named error for a state file from a newer release", () => {
    const newer = JSON.stringify({ version: 2, sequence: 7, state: { hypertables: [], continuousAggregates: [] } });
    expect(() => parseGeneratorState(newer)).toThrow(NewerStateFileError);
    expect(() => parseGeneratorState(newer)).toThrow(/newer prisma-extension-timescaledb/);
    expect(() => parseGeneratorState(newer)).toThrow(/version 2/);
    // Even a newer file with a shape this release cannot read is a newer file, not a corrupt one.
    expect(() => parseGeneratorState(JSON.stringify({ version: 3 }))).toThrow(NewerStateFileError);
    // Anything that is not an integer above 1 stays "unreadable".
    expect(parseGeneratorState(JSON.stringify({ version: "2", sequence: 1 }))).toBeUndefined();
    expect(parseGeneratorState(JSON.stringify({ version: 1.5, sequence: 1 }))).toBeUndefined();
    expect(parseGeneratorState(JSON.stringify({ version: 0, sequence: 1 }))).toBeUndefined();
    expect(parseGeneratorState("null")).toBeUndefined();
    expect(parseGeneratorState("5")).toBeUndefined();
  });
});

// Issue #161: schema changes that used to emit a migration which ran clean and changed nothing,
// after which the state file recorded the new value as done.
describe("emitMigrations converging diffs (issue #161)", () => {
  const V2 = `${objectsMigrationName(2)}/migration.sql`;
  type Schema = Awaited<ReturnType<typeof loadSchema>>;
  type Hypertable = Schema["hypertables"][number];
  type Cagg = Schema["continuousAggregates"][number];
  const withHypertable = (schema: Schema, patch: (h: Hypertable) => Hypertable): Schema => ({
    ...schema,
    hypertables: schema.hypertables.map(patch),
  });
  const withCagg = (schema: Schema, patch: (c: Cagg) => Cagg): Schema => ({
    ...schema,
    continuousAggregates: schema.continuousAggregates.map(patch),
  });

  it("a changed partition count on the same column converges through set_number_partitions", async () => {
    const schema = await loadSchema();
    const four = withHypertable(schema, (h) => ({ ...h, spacePartition: { column: "deviceId", partitions: 4 } }));
    const eight = withHypertable(schema, (h) => ({ ...h, spacePartition: { column: "deviceId", partitions: 8 } }));
    const first = emitMigrations(four);
    expect(first.files[`${objectsMigrationName(1)}/migration.sql`]).toContain(
      `PERFORM set_number_partitions('"SensorReading"', 4, 'deviceId');`,
    );
    const second = emitMigrations(eight, first.nextState, 1, true);
    expect(second.files[V2]).toContain(`PERFORM set_number_partitions('"SensorReading"', 8, 'deviceId');`);
    expect(second.warnings).toBeUndefined();
  });

  // add_dimension's if_not_exists skips a column that is already a dimension, and on a new
  // column it adds a THIRD dimension (probed on 2.27.2). Neither can be made to converge.
  it("throws for a changed time column, a changed partition column, or a removed space dimension", async () => {
    const schema = await loadSchema();
    const partitioned = withHypertable(schema, (h) => ({ ...h, spacePartition: { column: "deviceId", partitions: 4 } }));
    const first = emitMigrations(partitioned);

    const timeColumn = withHypertable(partitioned, (h) => ({ ...h, column: "createdAt" }));
    expect(() => emitMigrations(timeColumn, first.nextState, 1, true)).toThrow(
      /Hypertable SensorReading: the time column changed from "time" to "createdAt"/,
    );
    const otherColumn = withHypertable(partitioned, (h) => ({ ...h, spacePartition: { column: "temperature", partitions: 4 } }));
    expect(() => emitMigrations(otherColumn, first.nextState, 1, true)).toThrow(
      /space partition column changed from "deviceId" to "temperature"/,
    );
    const removed = withHypertable(partitioned, ({ spacePartition: _sp, ...h }) => h);
    expect(() => emitMigrations(removed, first.nextState, 1, true)).toThrow(/space dimension on "deviceId" was removed/);
    expect(() => emitMigrations(removed, first.nextState, 1, true)).toThrow(/new model/);
  });

  it("a hypertable that is dropped from the schema is not held to the layout rules", async () => {
    const schema = await loadSchema();
    const partitioned = withHypertable(schema, (h) => ({ ...h, spacePartition: { column: "deviceId", partitions: 4 } }));
    const first = emitMigrations(partitioned);
    const gone = { ...schema, hypertables: [], continuousAggregates: [] };
    expect(() => emitMigrations(gone, first.nextState, 1, true)).not.toThrow();
  });

  it("a removed segmentBy or orderBy is RESET before the policy is re-added", async () => {
    const schema = await loadSchema();
    const both = withHypertable(schema, (h) => ({
      ...h,
      compression: { after: "7 days" as const, segmentBy: ["deviceId"], orderBy: [{ column: "time", direction: "desc" as const }] },
    }));
    const first = emitMigrations(both);

    const noSegment = withHypertable(schema, (h) => ({
      ...h,
      compression: { after: "7 days" as const, orderBy: [{ column: "time", direction: "desc" as const }] },
    }));
    const v2 = emitMigrations(noSegment, first.nextState, 1, true).files[V2]!;
    expect(v2).toContain(`ALTER TABLE "SensorReading" RESET (timescaledb.segmentby);`);
    expect(v2).not.toContain(`RESET (timescaledb.orderby)`);
    // The reset runs in the removal block, ahead of the re-add that SETs the surviving option.
    expect(v2.indexOf("RESET (timescaledb.segmentby)")).toBeLessThan(v2.indexOf("add_columnstore_policy"));

    const noOrder = withHypertable(schema, (h) => ({ ...h, compression: { after: "7 days" as const, segmentBy: ["deviceId"] } }));
    const v2b = emitMigrations(noOrder, first.nextState, 1, true).files[V2]!;
    expect(v2b).toContain(`RESET (timescaledb.orderby)`);
    expect(v2b).not.toContain(`RESET (timescaledb.segmentby)`);

    // Compression removed entirely: both options go with it.
    const none = withHypertable(schema, ({ compression: _c, ...h }) => h);
    const v2c = emitMigrations(none, first.nextState, 1, true).files[V2]!;
    expect(v2c).toContain(`RESET (timescaledb.segmentby)`);
    expect(v2c).toContain(`RESET (timescaledb.orderby)`);

    // Only the interval changed: nothing to reset.
    const later = withHypertable(both, (h) => ({ ...h, compression: { ...h.compression!, after: "14 days" as const } }));
    expect(emitMigrations(later, first.nextState, 1, true).files[V2]).not.toContain("RESET (");
  });

  it("toggling materializedOnly alters the live view instead of dropping it", async () => {
    const schema = await loadSchema(); // materializedOnly omitted, which TimescaleDB reads as true
    const first = emitMigrations(schema);
    const realtime = withCagg(schema, (c) => ({ ...c, materializedOnly: false }));
    const v2 = emitMigrations(realtime, first.nextState, 1, true).files[V2]!;
    expect(v2).not.toContain("DROP MATERIALIZED VIEW");
    expect(v2).toContain(`ALTER MATERIALIZED VIEW "SensorHourly" SET (timescaledb.materialized_only = false);`);
    // Back again, and an explicit true from omitted is no change at all.
    const second = emitMigrations(realtime, first.nextState, 1, true);
    const back = emitMigrations(schema, second.nextState, 2, true).files[`${objectsMigrationName(3)}/migration.sql`]!;
    expect(back).toContain(`SET (timescaledb.materialized_only = true);`);
    const explicit = withCagg(schema, (c) => ({ ...c, materializedOnly: true }));
    expect(emitMigrations(explicit, first.nextState, 1, true)).toEqual({ files: {} });
  });

  it("a cagg that is dropped and recreated while its source has retention carries a warning", async () => {
    const schema = await loadSchema();
    const retained = withHypertable(schema, (h) => ({ ...h, retention: { dropAfter: "30 days" as const } }));
    const first = emitMigrations(retained);
    const wider = withCagg(retained, (c) => ({ ...c, bucket: "2 hours" as typeof c.bucket }));
    const { files, warnings } = emitMigrations(wider, first.nextState, 1, true);
    expect(files[V2]).toContain(`WARNING: source SensorReading drops rows after 30 days; buckets older than that are lost`);
    expect(warnings).toEqual([expect.stringMatching(/SensorHourly is dropped and recreated .* drops rows after 30 days/)]);
    // Without retention there is nothing to warn about.
    const plain = emitMigrations(withCagg(schema, (c) => ({ ...c, bucket: "2 hours" as typeof c.bucket })), emitMigrations(schema).nextState, 1, true);
    expect(plain.warnings).toBeUndefined();
    expect(plain.files[V2]).not.toContain("buckets older than that are lost");
  });

  it("enabling multiSchema re-qualifies every key without dropping anything", async () => {
    const schema = await loadSchema();
    const withPolicies = withHypertable(schema, (h) => ({ ...h, retention: { dropAfter: "30 days" as const } }));
    const first = emitMigrations(withPolicies);
    const qualified: Schema = {
      ...withPolicies,
      hypertables: withPolicies.hypertables.map((h) => ({ ...h, schema: "public" })),
      continuousAggregates: withPolicies.continuousAggregates.map((c) => ({ ...c, schema: "public", sourceSchema: "public" })),
    };
    // Nothing but the qualification changed: no migration, the state file takes the new keys.
    const flip = emitMigrations(qualified, first.nextState, 1, true);
    expect(flip.files).toEqual({});
    expect(flip.nextState?.sequence).toBe(1);
    expect(flip.nextState?.state.hypertables[0]?.schema).toBe("public");
    // The next run is a no-op again.
    expect(emitMigrations(qualified, flip.nextState, 1, true)).toEqual({ files: {} });

    // Qualification plus a real change in the same run: the migration notes the flip and
    // carries only the real change.
    const qualifiedWider = withCagg(qualified, (c) => ({ ...c, bucket: "2 hours" as typeof c.bucket }));
    const v2 = emitMigrations(qualifiedWider, first.nextState, 1, true).files[V2]!;
    expect(v2).toContain(`-- Schema qualification changed: hypertable SensorReading is now declared as public.SensorReading`);
    expect(v2).toContain(`DROP MATERIALIZED VIEW IF EXISTS "public"."SensorHourly"`);
    expect(v2).not.toContain("remove_retention_policy");
    expect(v2).not.toContain("Removed hypertable annotation");

    // And back: turning multiSchema off is the same flip in reverse.
    const back = emitMigrations(withPolicies, flip.nextState, 1, true);
    expect(back.files).toEqual({});
    expect(back.nextState?.state.hypertables[0]?.schema).toBeUndefined();

    // A relation that moved between two NAMED schemas is a real move, not a flip.
    const moved: Schema = {
      ...qualified,
      hypertables: qualified.hypertables.map((h) => ({ ...h, schema: "metrics" })),
      continuousAggregates: qualified.continuousAggregates.map((c) => ({ ...c, schema: "metrics", sourceSchema: "metrics" })),
    };
    const move = emitMigrations(moved, flip.nextState, 1, true).files[V2]!;
    expect(move).toContain("Removed hypertable annotation: public.SensorReading");
    expect(move).toContain(`DROP MATERIALIZED VIEW IF EXISTS "public"."SensorHourly"`);
  });
});
