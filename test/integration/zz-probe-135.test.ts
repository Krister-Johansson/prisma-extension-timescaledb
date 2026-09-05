// TEMPORARY PROBE v2 for #135 — not intended to be merged.
//
// Probe v1 established two things and refuted a third:
//   - the shadow database DOES keep the cagg after a migrate dev (shadow caggs: SensorHourly)
//   - five alternating --create-only / full migrate dev runs all PASSED with it sitting there
//   - so "cagg in the shadow" is NOT sufficient to fail, even though best_effort_reset drops
//     views before tables and TimescaleDB refuses DROP VIEW on a cagg
//
// Therefore Prisma only resets the shadow on some runs. This probe replays the exact sequence
// from migrate-dev-drift.test.ts (the one that actually fails) on FRESH harnesses, several
// times, recording the shadow around every single prisma invocation plus the migration folder
// and _prisma_migrations rows, so a failing repetition can be compared against a passing one.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import pg from "pg";
import { startHarness, type Harness, dockerAvailable } from "./harness.js";

const DOCKER_OK = dockerAvailable("PROBE #135 v2 did not run.");

const PRISMA_BIN = join(process.cwd(), "node_modules", ".bin", "prisma");

/** One line per observation, on stderr so it survives vitest's per-test console buffering. */
function log(msg: string): void {
  process.stderr.write(`[probe135v2] ${msg}\n`);
}

/** Relations in `public` by kind, so a cagg view and a plain table are distinguishable. */
async function relations(connectionString: string): Promise<string> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT c.relkind::text AS kind, c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p')
        ORDER BY 1, 2`,
    );
    const rows = res.rows as { kind: string; name: string }[];
    return rows.length === 0 ? "(empty)" : rows.map((r) => `${r.kind}:${r.name}`).join(", ");
  } finally {
    await client.end();
  }
}

/** Applied migration names, to see what the history looked like when a run failed. */
async function applied(connectionString: string): Promise<string> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query(
      "SELECT migration_name, finished_at IS NOT NULL AS done FROM _prisma_migrations ORDER BY started_at",
    );
    const rows = res.rows as { migration_name: string; done: boolean }[];
    return rows.length === 0 ? "(none)" : rows.map((r) => `${r.migration_name}${r.done ? "" : "(UNFINISHED)"}`).join(", ");
  } catch (e) {
    return `(query failed: ${(e as Error).message})`;
  } finally {
    await client.end();
  }
}

/** Run the Prisma CLI, returning its outcome instead of throwing, so the probe always reports. */
function runPrisma(h: Harness, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(PRISMA_BIN, args, {
      cwd: h.projectDir,
      env: {
        ...process.env,
        DATABASE_URL: h.databaseUrl,
        SHADOW_DATABASE_URL: h.shadowUrl,
        PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
      },
      stdio: "pipe",
      encoding: "utf8",
    });
    return { ok: true, out: out.trim().replace(/\n/g, " | ") };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${(err.stdout ?? "").trim()} ${(err.stderr ?? "").trim()}`.replace(/\n/g, " | ") };
  }
}

describe.skipIf(!DOCKER_OK)("PROBE #135 v2", () => {
  it("replays the migrate-dev-drift sequence on fresh harnesses", async () => {
    const REPS = 4;
    const outcomes: string[] = [];

    for (let rep = 1; rep <= REPS; rep++) {
      log(`===== repetition ${rep} =====`);
      const h = await startHarness();
      try {
        runPrisma(h, ["generate"]);
        const deploy = runPrisma(h, ["migrate", "deploy"]);
        log(`rep${rep} deploy: ${deploy.ok ? "OK" : "FAILED"}`);
        log(`rep${rep}   dev relations:    ${await relations(h.databaseUrl)}`);
        log(`rep${rep}   shadow relations: ${await relations(h.shadowUrl)}`);
        log(`rep${rep}   dev applied:      ${await applied(h.databaseUrl)}`);
        log(`rep${rep}   migrations dir:   ${readdirSync(join(h.projectDir, "migrations")).join(", ")}`);

        const co = runPrisma(h, ["migrate", "dev", "--create-only", "--name", "check"]);
        log(`rep${rep} create-only: ${co.ok ? "OK" : "FAILED"} :: ${co.out}`);
        log(`rep${rep}   dev relations:    ${await relations(h.databaseUrl)}`);
        log(`rep${rep}   shadow relations: ${await relations(h.shadowUrl)}`);
        log(`rep${rep}   dev applied:      ${await applied(h.databaseUrl)}`);
        log(`rep${rep}   migrations dir:   ${readdirSync(join(h.projectDir, "migrations")).join(", ")}`);

        const full = runPrisma(h, ["migrate", "dev", "--name", "check_applied"]);
        log(`rep${rep} full migrate dev: ${full.ok ? "OK" : "FAILED"} :: ${full.out}`);
        log(`rep${rep}   dev relations:    ${await relations(h.databaseUrl)}`);
        log(`rep${rep}   shadow relations: ${await relations(h.shadowUrl)}`);
        log(`rep${rep}   dev applied:      ${await applied(h.databaseUrl)}`);

        outcomes.push(`rep${rep}: create-only=${co.ok ? "OK" : "FAIL"} full=${full.ok ? "OK" : "FAIL"}`);
      } finally {
        await h.stop();
      }
    }

    log("===== summary =====");
    for (const o of outcomes) log(o);
  }, 900_000);
});
