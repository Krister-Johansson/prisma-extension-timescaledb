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

const { generatorHandler } = generatorHelper;
import {
  emitMigrations,
  maxObjectsSequence,
  parseGeneratorState,
  STATE_FILE,
  type FileMap,
  type GeneratorState,
} from "./emit-migrations.js";
import { emitTypes } from "./emit-types.js";

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

    // Previous emitted state, so a changed schema appends the NEXT versioned objects migration
    // and an unchanged one is a byte-stable no-op. On a missing/corrupt state file, the highest
    // existing ..._v000N folder pins the next sequence, so recovery re-asserts the full state
    // as a NEW migration and never overwrites an applied one.
    const { files, nextState } = emitMigrations(
      schema,
      readState(join(migrationsDir, STATE_FILE)),
      maxObjectsSequence(listDir(migrationsDir)),
    );
    writeFileMap(migrationsDir, files);
    if (nextState) {
      mkdirSync(migrationsDir, { recursive: true });
      writeFileSync(join(migrationsDir, STATE_FILE), JSON.stringify(nextState, null, 2) + "\n", "utf8");
    }
    writeFileMap(typesDir, emitTypes(schema));
  },
});

/** Read the generator state file; undefined (with a warning) when absent or unusable. The
 * shape validation lives in parseGeneratorState so it is unit-testable without a filesystem. */
function readState(path: string): GeneratorState | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined; // no file — first run, or pre-v1 project
  }
  const state = parseGeneratorState(raw);
  if (state === undefined) {
    console.warn(
      `prisma-extension-timescaledb: ignoring unreadable state file at ${path}; re-asserting the full state as a new migration.`,
    );
  }
  return state;
}

/** Directory entries of `dir`, or empty when it does not exist yet. */
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
