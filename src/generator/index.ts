#!/usr/bin/env node
// Prisma generator entry (SPEC §5 / BUILD_PLAN M3). Runs as a binary spawned by
// `prisma generate`. It produces the configs (via the DMMF-isolated dmmf.ts), then writes
// the reset-safe migrations (emit-migrations) and the generated type module (emit-types).
//
// This file is intentionally NOT imported by the runtime entry (src/index.ts): the client
// extension must work without the generator (CLAUDE.md resilience requirement).
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
// Default import (not named): @prisma/generator-helper is CommonJS, and Node's ESM loader
// rejects named imports from it at runtime. Default import resolves to module.exports under
// both ESM and CJS output.
import generatorHelper from "@prisma/generator-helper";
import { extractTimescaleSchema } from "./dmmf.js";
import { assertSafeIdent } from "../core/sql.js";

const { generatorHandler } = generatorHelper;
import {
  emitMigrations,
  maxObjectsSequence,
  objectsMigrationName,
  parseGeneratorState,
  EXTENSION_MIGRATION,
  MissingMigrationError,
  NewerStateFileError,
  STATE_FILE,
  type FileMap,
  type GeneratorState,
} from "./emit-migrations.js";
import { emitTypes } from "./emit-types.js";
import { assertSupportedPrismaVersion, installedPrismaVersion } from "./prismaVersion.js";

const DEFAULT_OUTPUT = "node_modules/.prisma-extension-timescaledb";

/** Write a { relativePath -> content } map under baseDir, creating directories as needed. */
export function writeFileMap(baseDir: string, files: FileMap): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(baseDir, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

generatorHandler({
  onManifest() {
    return {
      prettyName: "TimescaleDB (prisma-extension-timescaledb)",
      defaultOutput: DEFAULT_OUTPUT,
    };
  },

  async onGenerate(options) {
    const versionWarning = assertSupportedPrismaVersion(installedPrismaVersion(import.meta.url));
    if (versionWarning) console.warn(versionWarning);
    const schema = extractTimescaleSchema(options.dmmf);

    const typesDir = options.generator.output?.value ?? DEFAULT_OUTPUT;

    // Prisma's migrations live next to the schema unless overridden via the generator's
    // `migrationsDir` config option (relative paths resolve against the schema directory).
    const schemaDir = dirname(options.schemaPath);
    const migrationsConfig = options.generator.config["migrationsDir"];
    const migrationsDir =
      typeof migrationsConfig === "string"
        ? isAbsolute(migrationsConfig)
          ? migrationsConfig
          : join(schemaDir, migrationsConfig)
        : join(schemaDir, "migrations");

    // The schema an unqualified relation lives in. The generator never sees the connection URL
    // (Prisma 7 keeps it in prisma.config.ts), so a project whose URL sets `?schema=` names it
    // here; everything else is `public`.
    const defaultSchemaConfig = options.generator.config["defaultSchema"];
    const defaultSchema = typeof defaultSchemaConfig === "string" ? defaultSchemaConfig : "public";
    assertSafeIdent(defaultSchema, "generator defaultSchema");

    // Previous emitted state, so a changed schema appends the NEXT versioned objects migration
    // and an unchanged one is a byte-stable no-op. On a missing/corrupt state file, the highest
    // existing ..._v000N folder pins the next sequence, so recovery re-asserts the full state
    // as a NEW migration and never overwrites an applied one.
    const existing = listDir(migrationsDir);
    const previous = readState(join(migrationsDir, STATE_FILE));
    // The state file names the latest objects migration; when that folder is gone, the
    // recorded state has nothing behind it and the emitter rebuilds it as the next version.
    const latestExists = previous === undefined || existing.includes(objectsMigrationName(previous.sequence));
    let result: ReturnType<typeof emitMigrations>;
    try {
      result = emitMigrations(
        schema,
        previous,
        maxObjectsSequence(existing),
        existing.includes(EXTENSION_MIGRATION),
        latestExists,
        defaultSchema,
      );
    } catch (e) {
      if (e instanceof MissingMigrationError) {
        throw new Error(`prisma-extension-timescaledb: ${join(migrationsDir, e.migration)}: ${e.message}`);
      }
      throw e;
    }
    const { files, nextState, warnings } = result;
    for (const warning of warnings ?? []) console.warn(`prisma-extension-timescaledb: ${warning}`);
    // Warned only once something is actually written, so the message never precedes an abort.
    if (!latestExists && nextState) {
      console.warn(
        `prisma-extension-timescaledb: ${objectsMigrationName(previous.sequence)} is missing from ${migrationsDir}; rebuilding it as ${objectsMigrationName(nextState.sequence)}. If the missing migration was already applied somewhere, the rebuilt one re-runs its drop-and-recreate of changed continuous aggregates there, and their data refills on the next refresh.`,
      );
    }
    writeFileMap(migrationsDir, files);
    if (nextState) {
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, STATE_FILE), JSON.stringify(nextState, null, 2) + "\n", "utf8");
    }
    writeFileMap(typesDir, emitTypes(schema));
  },
});

/** Read the generator state file; undefined when absent (first run, or a pre-v1 project) or,
 * with a warning, when unusable. Any read error other than ENOENT rethrows, like listDir: an
 * EACCES or EISDIR read as "first run" would put a full re-assert migration on disk and then
 * fail on the state write. A file from a newer release aborts with the path in the message.
 * The shape validation lives in parseGeneratorState so it is unit-testable without a filesystem. */
function readState(path: string): GeneratorState | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let state: GeneratorState | undefined;
  try {
    state = parseGeneratorState(raw);
  } catch (e) {
    if (e instanceof NewerStateFileError) throw new Error(`prisma-extension-timescaledb: ${path}: ${e.message}`);
    throw e;
  }
  if (state === undefined) {
    console.warn(
      `prisma-extension-timescaledb: ignoring unreadable state file at ${path}; re-asserting the full state as a new migration.`,
    );
  }
  return state;
}

/** Directory entries of `dir`, or empty when it does not exist yet. Any error other than
 * ENOENT rethrows: an unreadable migrations dir (EACCES) must abort, not read as "no history"
 * and let a later write truncate an existing versioned migration. */
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}
