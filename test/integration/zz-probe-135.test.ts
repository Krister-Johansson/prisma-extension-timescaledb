// TEMPORARY PROBE for #135 — not intended to be merged.
//
// Question: after `prisma migrate dev`, does the SHADOW database still hold the continuous
// aggregate? Prisma's reset is a *soft* reset whenever shadowDatabaseUrl is configured
// (schema-engine: `if soft || self.inner.reset(..).is_err() { best_effort_reset(..) }`), and
// best_effort_reset drops every view it can describe with DROP VIEW, which TimescaleDB refuses
// on a cagg. If the shadow retains the cagg between runs, the second migrate dev must fail
// every time — which contradicts the observed pass rate, so something in that model is wrong.
//
// This records the actual state rather than reasoning about it.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import pg from "pg";
import { startHarness, type Harness, dockerAvailable } from "./harness.js";

const DOCKER_OK = dockerAvailable("PROBE #135 did not run.");

const PRISMA_BIN = join(process.cwd(), "node_modules", ".bin", "prisma");

function log(msg: string): void {
  process.stderr.write(`[probe135] ${msg}\n`);
}

/** Relations in `public`, by kind, so a cagg (a view) and its matview are both visible. */
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

/** Does TimescaleDB consider anything here a continuous aggregate? */
async function caggs(connectionString: string): Promise<string> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query(
      "SELECT view_name FROM timescaledb_information.continuous_aggregates ORDER BY 1",
    );
    const rows = res.rows as { view_name: string }[];
    return rows.length === 0 ? "(none)" : rows.map((r) => r.view_name).join(", ");
  } catch (e) {
    return `(query failed: ${(e as Error).message})`;
  } finally {
    await client.end();
  }
}

describe.skipIf(!DOCKER_OK)("PROBE #135", () => {
  let h: Harness;
  let devUrl: string;
  let shadowUrl: string;

  beforeAll(async () => {
    h = await startHarness();
    devUrl = h.databaseUrl;
    shadowUrl = h.shadowUrl;
    h.prisma(["generate"]);
    h.prisma(["migrate", "deploy"]);
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it("records dev + shadow state across repeated migrate dev runs", async () => {
    log(`dev    after deploy: ${await relations(devUrl)}`);
    log(`dev    caggs:        ${await caggs(devUrl)}`);
    log(`shadow after deploy: ${await relations(shadowUrl)}`);
    log(`shadow caggs:        ${await caggs(shadowUrl)}`);

    for (let i = 1; i <= 5; i++) {
      const args =
        i % 2 === 1
          ? ["migrate", "dev", "--create-only", "--name", `probe_co_${i}`]
          : ["migrate", "dev", "--name", `probe_full_${i}`];

      log(`--- iteration ${i}: prisma ${args.join(" ")} ---`);
      let outcome = "OK";
      try {
        const out = execFileSync(PRISMA_BIN, args, {
          cwd: h.projectDir,
          env: {
            ...process.env,
            DATABASE_URL: devUrl,
            SHADOW_DATABASE_URL: shadowUrl,
            PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION: "yes",
          },
          stdio: "pipe",
          encoding: "utf8",
        });
        log(`stdout: ${out.trim().replace(/\n/g, " | ")}`);
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message: string };
        outcome = "FAILED";
        log(`stdout: ${(err.stdout ?? "").trim().replace(/\n/g, " | ")}`);
        log(`stderr: ${(err.stderr ?? "").trim().replace(/\n/g, " | ")}`);
      }
      log(`iteration ${i}: ${outcome}`);
      log(`  dev    relations: ${await relations(devUrl)}`);
      log(`  dev    caggs:     ${await caggs(devUrl)}`);
      log(`  shadow relations: ${await relations(shadowUrl)}`);
      log(`  shadow caggs:     ${await caggs(shadowUrl)}`);
    }
  }, 600_000);
});
