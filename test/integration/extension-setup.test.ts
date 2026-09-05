// The extension migration, against the databases that make it hard.
//
// `timescaledb.control` names no schema and is relocatable at install time, so a bare
// `CREATE EXTENSION` installs into the first existing schema on the search path. Prisma runs
// migrations with `search_path` set to the datasource schema alone, and this migration sorts
// before the one that creates that schema, so the placement is never something the builder can
// take for granted.
//
// These cases need a database with no `timescaledb` in it, which the harness cannot give: the
// image installs the extension into `template1`, so every database cloned from it already has
// one in `public`. Each test creates its own from `template0` instead.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { IMAGE } from "./harness.js";
import { createExtensionSql } from "../../src/core/index.js";

const DOCKER_OK = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!DOCKER_OK) {
  console.warn("\n[integration] SKIPPED extension-setup.test.ts: Docker is not available. Extension setup is NOT verified.\n");
}

const EXTENSION_SQL = createExtensionSql().up;

describe.skipIf(!DOCKER_OK)("extension setup", () => {
  let container: StartedTestContainer;
  let base: { host: string; port: number; user: string; password: string };

  const connect = async (database: string): Promise<pg.Client> => {
    const client = new pg.Client({ ...base, database });
    await client.connect();
    return client;
  };

  /** A database with no `timescaledb` extension: template0, not the image's template1. */
  const freshDb = async (name: string): Promise<pg.Client> => {
    const admin = await connect("postgres");
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
    } finally {
      await admin.end();
    }
    return connect(name);
  };

  const extensionSchema = async (client: pg.Client): Promise<string | undefined> => {
    const { rows } = await client.query<{ nspname: string }>(
      "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'timescaledb'",
    );
    return rows[0]?.nspname;
  };

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withEnvironment({ POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "app" })
      .withExposedPorts(5432)
      .start();
    base = { host: container.getHost(), port: container.getMappedPort(5432), user: "postgres", password: "postgres" };
    for (let i = 0; i < 30; i++) {
      try {
        const c = await connect("postgres");
        await c.end();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }, 300_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("pins public rather than following the search path into the datasource schema", async () => {
    const db = await freshDb("pins_public");
    try {
      await db.query('CREATE SCHEMA "data_collection"');
      await db.query('SET search_path TO "data_collection"');
      await db.query(EXTENSION_SQL);
      expect(await extensionSchema(db)).toBe("public");
    } finally {
      await db.end();
    }
  }, 120_000);

  // Nothing has created the datasource schema yet: this migration sorts before the one that
  // does. A bare CREATE EXTENSION would fail here with "no schema has been selected to create in".
  it("succeeds when the datasource schema does not exist yet", async () => {
    const db = await freshDb("schema_missing");
    try {
      await db.query('SET search_path TO "data_collection"');
      await db.query(EXTENSION_SQL);
      expect(await extensionSchema(db)).toBe("public");
    } finally {
      await db.end();
    }
  }, 120_000);

  it("falls back to the search path on a database whose public schema was dropped", async () => {
    const db = await freshDb("no_public");
    try {
      await db.query("DROP SCHEMA public CASCADE");
      await db.query('CREATE SCHEMA "data_collection"');
      await db.query('SET search_path TO "data_collection"');
      await db.query(EXTENSION_SQL);
      expect(await extensionSchema(db)).toBe("data_collection");
    } finally {
      await db.end();
    }
  }, 120_000);

  // No public, and the datasource schema is created by a later migration: there is nowhere to
  // put the extension, and creating someone's datasource schema is Prisma's job. Say so.
  it("explains itself when no schema on the search path exists", async () => {
    const db = await freshDb("no_public_no_schema");
    try {
      await db.query("DROP SCHEMA public CASCADE");
      await db.query('SET search_path TO "data_collection"');
      await expect(db.query(EXTENSION_SQL)).rejects.toThrow(
        /prisma-extension-timescaledb: cannot install the timescaledb extension.*Create the schema first/s,
      );
      expect(await extensionSchema(db)).toBeUndefined();
    } finally {
      await db.end();
    }
  }, 120_000);

  it("leaves an extension that already lives in another schema alone", async () => {
    const db = await freshDb("already_elsewhere");
    try {
      await db.query('CREATE SCHEMA "ts_ext"');
      await db.query('CREATE EXTENSION timescaledb WITH SCHEMA "ts_ext" CASCADE');
      await db.query(EXTENSION_SQL);
      expect(await extensionSchema(db)).toBe("ts_ext");
    } finally {
      await db.end();
    }
  }, 120_000);

  // Two sessions racing. Prisma's migration engine serializes its own runs with an advisory
  // lock, but createExtensionSql() is public API for hand-written migrations, and
  // PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK turns Prisma's lock off. Session A holds an uncommitted
  // CREATE EXTENSION, which session B's existence check cannot see, so B proceeds to its own
  // CREATE and blocks on pg_extension's unique index. Without the EXCEPTION clause B fails with
  // `23505 duplicate key value violates unique constraint "pg_extension_name_index"`.
  it("does not fail the session that loses a concurrent creation", async () => {
    const a = await freshDb("race");
    const b = await connect("race");
    try {
      await a.query("BEGIN");
      await a.query("CREATE EXTENSION timescaledb CASCADE");

      let settled = false;
      const running = b.query(EXTENSION_SQL).then(
        () => ({ ok: true as const }),
        (e: Error) => ({ ok: false as const, e }),
      ).then((r) => {
        settled = true;
        return r;
      });

      await new Promise((r) => setTimeout(r, 800));
      expect(settled).toBe(false); // B is blocked on A's uncommitted row

      await a.query("COMMIT");
      expect(await running).toEqual({ ok: true });
      expect(await extensionSchema(b)).toBe("public");
    } finally {
      await a.end();
      await b.end();
    }
  }, 120_000);
});
