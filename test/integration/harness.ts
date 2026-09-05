// Integration harness: spins up a real TimescaleDB (Testcontainers), scaffolds a temp
// Prisma project that uses OUR generator binary, and drives the real prisma CLI.
//
// The temp project is created UNDER the repo root so Node resolves prisma / dotenv /
// @prisma/generator-helper from the repo's node_modules.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pg from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PRISMA_BIN = join(REPO_ROOT, "node_modules", ".bin", "prisma");
const GENERATOR_PROVIDER = join(REPO_ROOT, "dist", "generator", "index.js");
// Pinned to an immutable version tag for reproducible CI (not a rolling tag). The `-ha` image
// carries the same TimescaleDB 2.27.2 PLUS the `timescaledb_toolkit` extension (hyperfunctions),
// which the slim `timescaledb` image lacks — needed for the percentile / hyperfunction tests.
export const IMAGE = "timescale/timescaledb-ha:pg17.10-ts2.27.2";

// Prisma 7 blocks destructive commands from AI agents without explicit consent; the user
// granted it for this build (their message: "yes"). Required so reset runs unattended.
const PRISMA_CONSENT = "yes";

/** Retries for the Docker probe, so one hiccup cannot silently cost a file's coverage. */
const DOCKER_PROBE_ATTEMPTS = 3;
/** Where Docker is expected, an unavailable daemon is a failure, not a skip. */
const DOCKER_REQUIRED = process.env["REQUIRE_DOCKER"] === "1" || process.env["CI"] === "true";

export interface Harness {
  container: StartedTestContainer;
  projectDir: string;
  databaseUrl: string;
  shadowUrl: string;
  /** Run a query against the app database and return rows. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run the prisma CLI in the temp project. */
  prisma(args: string[]): void;
  stop(): Promise<void>;
}

/**
 * The extended PrismaClient of a temp test project. Its client is GENERATED at runtime inside the
 * project dir, so no compile-time types exist for it — this alias is the repo's one sanctioned
 * explicit `any` (policy: no `any` unless absolutely necessary). Integration tests type their
 * dynamically imported client with this instead of a local `any`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime-generated client, no static types exist
export type TestPrismaClient = any;

/**
 * Whether Docker is usable, for the `describe.skipIf` every integration file guards itself with.
 *
 * `docker info` is retried, because a single hiccup from a busy daemon used to turn a whole
 * file's tests into a silent skip while the run still reported green. That is coverage
 * disappearing without anyone being told, which is the opposite of what these tests are for.
 *
 * Where Docker is supposed to exist, an unavailable daemon THROWS instead of skipping. CI runners
 * ship Docker, so a skip there never means "no Docker available", it means something broke and
 * the suite quietly proved nothing. Set `REQUIRE_DOCKER=1` to demand the same locally.
 *
 * @param whatIsNotVerified what the reader loses by this file being skipped, named concretely.
 */
export function dockerAvailable(whatIsNotVerified: string): boolean {
  for (let attempt = 1; attempt <= DOCKER_PROBE_ATTEMPTS; attempt++) {
    try {
      execFileSync("docker", ["info"], { stdio: "ignore" });
      return true;
    } catch {
      // Synchronous: the value is read at collection time, before any hook can await.
      if (attempt < DOCKER_PROBE_ATTEMPTS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }

  if (DOCKER_REQUIRED) {
    throw new Error(
      `[integration] Docker is required here (CI, or REQUIRE_DOCKER=1) but \`docker info\` failed ` +
        `${DOCKER_PROBE_ATTEMPTS} times. Failing instead of skipping: ${whatIsNotVerified}`,
    );
  }
  // Written straight to stderr, not console.warn: vitest buffers console output per test and
  // drops it for a file whose tests are all skipped, which is precisely this case. The whole
  // point is that a skip announces what it cost.
  process.stderr.write(`\n[integration] SKIPPED: Docker is not available. ${whatIsNotVerified}\n`);
  return false;
}

/** Ensure the package (incl. the generator binary) is built. */
export function ensureBuilt(): void {
  if (!existsSync(GENERATOR_PROVIDER)) {
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
}

export interface HarnessOptions {
  /** Override the model/view definitions (the generator/datasource header is always added). */
  models?: string;
  /** Override the Prisma CREATE TABLE migration SQL (must match the schema's DB names). */
  initSql?: string;
  /** Extra generator preview features (merged with the default ["views"]). */
  previewFeatures?: string[];
  /** Datasource schemas (enables multiSchema); when set, adds `schemas = [...]`. */
  schemas?: string[];
  /**
   * The `?schema=` on the connection string, which is the search_path Prisma runs migrations
   * under. Defaults to "public". Set it to a non-public schema to reproduce a project that keeps
   * its tables (and `_prisma_migrations`) out of `public`, where TimescaleDB's own functions are
   * no longer on the search path (issue #129).
   */
  urlSchema?: string;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  ensureBuilt();

  // The image declares no HEALTHCHECK (`docker inspect` reports null), so testcontainers would
  // fall back to waiting on the mapped port alone. A bound port only means something is
  // listening, not that Postgres will accept a connection. The entrypoint starts a throwaway
  // server to run the init scripts and then restarts, so the ready line appears exactly twice;
  // waiting for the second one is what actually says the real server is up.
  const container = await new GenericContainer(IMAGE)
    .withEnvironment({ POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "app" })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forAll([Wait.forListeningPorts(), Wait.forLogMessage(/database system is ready to accept connections/, 2)]),
    )
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const baseUrl = `postgresql://postgres:postgres@${host}:${port}`;
  const urlSchema = opts.urlSchema ?? "public";
  const databaseUrl = `${baseUrl}/app?schema=${urlSchema}`;
  const shadowUrl = `${baseUrl}/shadow?schema=${urlSchema}`;

  // Everything from here on can throw, and until we return a Harness the caller has no stop() to
  // reach. Without this the container outlives the failed startup, and a run that trips the same
  // failure in several files leaves that many containers behind.
  const projectDir = await onFailureStopContainer(container, async () => {
    // Belt and braces on top of the wait strategy: prove a real client session works.
    await withContainerLogs(container, "waiting for Postgres to accept connections", () =>
      waitForReady(`${baseUrl}/app`),
    );
    // Shadow DB on the same server (TimescaleDB-capable), required by migrate reset/dev. Retried
    // like everything else that touches the network here: an unretried statement between container
    // start and the first test is exactly the shape of failure that shows up as a beforeAll throw
    // once in a few hundred container starts, with no output left behind to explain it.
    await withContainerLogs(container, "creating the shadow database", () =>
      retry(() => runOnce(`${baseUrl}/postgres`, "CREATE DATABASE shadow")),
    );

    const dir = mkdtempSync(join(REPO_ROOT, ".tmp-int-"));
    try {
      scaffoldProject(dir, opts);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    return dir;
  });

  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SHADOW_DATABASE_URL: shadowUrl,
    PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: PRISMA_CONSENT,
  };

  const prisma = (args: string[]): void => {
    execFileSync(PRISMA_BIN, args, { cwd: projectDir, env, stdio: "pipe" });
  };

  const query = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const res = await client.query(sql, params);
      return res.rows as T[];
    } finally {
      await client.end();
    }
  };

  return {
    container,
    projectDir,
    databaseUrl,
    shadowUrl,
    query,
    prisma,
    async stop() {
      rmSync(projectDir, { recursive: true, force: true });
      await container.stop();
    },
  };
}

// --- scaffolding -----------------------------------------------------------

function scaffoldProject(dir: string, opts: HarnessOptions): void {
  writeFileSync(join(dir, "prisma.config.ts"), PRISMA_CONFIG);
  writeFileSync(join(dir, "schema.prisma"), schemaPrisma(opts.models ?? DEFAULT_MODELS, opts));

  const migrations = join(dir, "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, "migration_lock.toml"), 'provider = "postgresql"\n');

  // Prisma's normal CREATE TABLE migration (the user's own). Our generator adds the
  // extension (sorts first) and the hypertable+cagg objects (sorts last) at generate time.
  const init = join(migrations, "20260101000000_init");
  mkdirSync(init, { recursive: true });
  writeFileSync(join(init, "migration.sql"), opts.initSql ?? INIT_TABLE_SQL);
}

const PRISMA_CONFIG = `import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "schema.prisma",
  migrations: { path: "migrations" },
  datasource: {
    url: process.env["DATABASE_URL"],
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
`;

function schemaPrisma(models: string, opts: HarnessOptions): string {
  // provider is an absolute path to our built generator binary.
  const provider = GENERATOR_PROVIDER.replace(/\\/g, "/");
  const previewFeatures = JSON.stringify(["views", ...(opts.previewFeatures ?? [])]);
  const schemasLine = opts.schemas ? `\n  schemas  = ${JSON.stringify(opts.schemas)}` : "";
  return `generator client {
  provider        = "prisma-client"
  output          = "./client"
  previewFeatures = ${previewFeatures}
}

generator timescaledb {
  provider = "${provider}"
  output   = "./timescale"
}

datasource db {
  provider = "postgresql"${schemasLine}
}

${models}`;
}

const DEFAULT_MODELS = `/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupBy
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "temperature")

  @@unique([deviceId, bucket])
}
`;

const INIT_TABLE_SQL = `-- CreateTable
CREATE TABLE "SensorReading" (
    "time" TIMESTAMP(3) NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SensorReading_pkey" PRIMARY KEY ("deviceId","time")
);

-- CreateIndex
CREATE INDEX "SensorReading_deviceId_time_idx" ON "SensorReading"("deviceId", "time");
`;

// --- pg helpers ------------------------------------------------------------

async function waitForReady(connectionString: string, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("TimescaleDB did not become ready in time");
}

/**
 * Retry a step that touches the container, with a short backoff.
 *
 * A step that runs exactly once between container start and the first test has no second chance:
 * if it throws, `startHarness` throws, the `beforeAll` throws, and vitest marks the file failed
 * and skips its tests (verified against @vitest/runner: a failing beforeAll calls `failTask` then
 * `markTasksAsSkipped`). That is a whole file of coverage lost to one transient.
 */
async function retry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // "already exists" means a previous attempt actually succeeded and the failure was in
      // the acknowledgement; nothing is gained by trying again.
      if (e instanceof Error && /already exists/i.test(e.message)) return undefined as T;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
  throw last;
}

/**
 * Run a startup step, and on failure attach the container's log tail to the error.
 *
 * The reason the one observed failure of this harness could not be diagnosed is that nothing
 * survived it. Postgres writes the reason it refused a connection to its own log, so put that in
 * front of whoever reads the failure instead of leaving them to reconstruct it.
 */
async function withContainerLogs<T>(
  container: StartedTestContainer,
  step: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    let tail = "(container logs unavailable)";
    try {
      const stream = await container.logs();
      const chunks: string[] = [];
      await new Promise<void>((resolve) => {
        stream.on("data", (c: Buffer | string) => chunks.push(String(c)));
        stream.on("end", () => resolve());
        stream.on("error", () => resolve());
        setTimeout(resolve, 5000).unref?.();
      });
      tail = chunks.join("").split("\n").slice(-40).join("\n");
    } catch {
      // fall through to the placeholder
    }
    throw new Error(`[harness] failed while ${step}: ${(e as Error).message}\n--- container logs (tail) ---\n${tail}`);
  }
}

/**
 * Run the startup steps that happen after `container.start()` but before a `Harness` exists. On
 * failure the container is stopped, since the caller never gets a `stop()` to call, and the
 * original error is rethrown: a failure to stop must not replace the reason startup failed.
 */
async function onFailureStopContainer<T>(container: StartedTestContainer, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    try {
      await container.stop();
    } catch {
      // The startup failure is the useful one; a failed stop would only mask it.
    }
    throw e;
  }
}

async function runOnce(connectionString: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
