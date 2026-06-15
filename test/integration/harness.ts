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
import { GenericContainer, type StartedTestContainer } from "testcontainers";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PRISMA_BIN = join(REPO_ROOT, "node_modules", ".bin", "prisma");
const GENERATOR_PROVIDER = join(REPO_ROOT, "dist", "generator", "index.js");
// Pinned to an immutable version tag for reproducible CI (not `latest-pg17`).
const IMAGE = "timescale/timescaledb:2.27.2-pg17";

// Prisma 7 blocks destructive commands from AI agents without explicit consent; the user
// granted it for this build (their message: "yes"). Required so reset runs unattended.
const PRISMA_CONSENT = "yes";

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

/** Ensure the package (incl. the generator binary) is built. */
export function ensureBuilt(): void {
  if (!existsSync(GENERATOR_PROVIDER)) {
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
}

export async function startHarness(): Promise<Harness> {
  ensureBuilt();

  const container = await new GenericContainer(IMAGE)
    .withEnvironment({ POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "app" })
    .withExposedPorts(5432)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const baseUrl = `postgresql://postgres:postgres@${host}:${port}`;
  const databaseUrl = `${baseUrl}/app?schema=public`;
  const shadowUrl = `${baseUrl}/shadow?schema=public`;

  // Wait until Postgres actually accepts connections (the image restarts once during init).
  await waitForReady(`${baseUrl}/app`);
  // Shadow DB on the same server (TimescaleDB-capable), required by migrate reset/dev.
  await runOnce(`${baseUrl}/postgres`, "CREATE DATABASE shadow");

  const projectDir = mkdtempSync(join(REPO_ROOT, ".tmp-int-"));
  scaffoldProject(projectDir);

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

function scaffoldProject(dir: string): void {
  writeFileSync(join(dir, "prisma.config.ts"), PRISMA_CONFIG);
  writeFileSync(join(dir, "schema.prisma"), schemaPrisma());

  const migrations = join(dir, "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(migrations, "migration_lock.toml"), 'provider = "postgresql"\n');

  // Prisma's normal CREATE TABLE migration (the user's own). Our generator adds the
  // extension (sorts first) and the hypertable+cagg objects (sorts last) at generate time.
  const init = join(migrations, "20260101000000_init");
  mkdirSync(init, { recursive: true });
  writeFileSync(join(init, "migration.sql"), INIT_TABLE_SQL);
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

function schemaPrisma(): string {
  // provider is an absolute path to our built generator binary.
  const provider = GENERATOR_PROVIDER.replace(/\\/g, "/");
  return `generator client {
  provider        = "prisma-client"
  output          = "./client"
  previewFeatures = ["views"]
}

generator timescaledb {
  provider = "${provider}"
  output   = "./timescale"
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
}

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

async function runOnce(connectionString: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
