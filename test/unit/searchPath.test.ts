import { describe, expect, it, vi } from "vitest";
import { memoizeFnPrefix, probeFnPrefix, NO_PREFIX } from "../../src/client/searchPath.js";
import type { RawClient } from "../../src/client/manage.js";

/** A RawClient whose $queryRawUnsafe returns a canned probe row (or throws). */
function stubClient(row: unknown, onQuery?: () => void): RawClient & { calls: number } {
  const client = {
    calls: 0,
    $executeRawUnsafe: async () => 0,
    async $queryRawUnsafe<T>(): Promise<T> {
      client.calls++;
      onQuery?.();
      if (row instanceof Error) throw row;
      return [row] as T;
    },
  };
  return client;
}

describe("probeFnPrefix", () => {
  it("qualifies nothing when both extensions already resolve", async () => {
    const c = stubClient({ ts_schema: "public", tk_schema: "public", ts_visible: true, tk_visible: true });
    expect(await probeFnPrefix(c)).toEqual({ ts: "", tk: "" });
  });

  it("qualifies with the installed schema when the functions are out of reach", async () => {
    const c = stubClient({ ts_schema: "public", tk_schema: "public", ts_visible: false, tk_visible: false });
    expect(await probeFnPrefix(c)).toEqual({ ts: `"public".`, tk: `"public".` });
  });

  // Two extensions, so two schemas and two answers. Core out of reach, Toolkit still visible.
  it("treats the two extensions independently", async () => {
    const c = stubClient({ ts_schema: "tsdb", tk_schema: "public", ts_visible: false, tk_visible: true });
    expect(await probeFnPrefix(c)).toEqual({ ts: `"tsdb".`, tk: "" });
  });

  it("qualifies nothing for an extension that is not installed", async () => {
    const c = stubClient({ ts_schema: "public", tk_schema: null, ts_visible: false, tk_visible: false });
    expect(await probeFnPrefix(c)).toEqual({ ts: `"public".`, tk: "" });
  });

  it("quotes a schema name that needs it", async () => {
    const c = stubClient({ ts_schema: 'we"ird', tk_schema: null, ts_visible: false, tk_visible: false });
    expect((await probeFnPrefix(c)).ts).toBe(`"we""ird".`);
  });

  // Qualification improves on the unqualified SQL; it is not a precondition for sending it.
  // `undefined` rather than NO_PREFIX, so the caching can tell "nothing to do" from "no answer".
  it("reports no answer when the probe fails", async () => {
    expect(await probeFnPrefix(stubClient(new Error("permission denied")))).toBeUndefined();
  });

  it("reports no answer when the probe returns no rows", async () => {
    const c: RawClient = { $executeRawUnsafe: async () => 0, $queryRawUnsafe: async <T>() => [] as T };
    expect(await probeFnPrefix(c)).toBeUndefined();
  });
});

describe("memoizeFnPrefix", () => {
  it("probes once however many callers ask", async () => {
    const c = stubClient({ ts_schema: "public", tk_schema: "public", ts_visible: false, tk_visible: false });
    const resolve = memoizeFnPrefix(c);
    const [a, b, d] = await Promise.all([resolve(), resolve(), resolve()]);
    expect(c.calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(d);
    await resolve();
    expect(c.calls).toBe(1);
  });

  // One blip must not leave the client emitting unqualified SQL forever: on a narrowed search
  // path that would fail every later query.
  it("retries after a probe that could not reach the database, and caches the answer it gets", async () => {
    let fail = true;
    const query = vi.fn(async () => {
      if (fail) throw new Error("connection lost");
      return [{ ts_schema: "public", tk_schema: "public", ts_visible: false, tk_visible: false }];
    });
    const client: RawClient = {
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: query as unknown as RawClient["$queryRawUnsafe"],
    };
    const resolve = memoizeFnPrefix(client);

    expect(await resolve()).toEqual(NO_PREFIX); // fell back, cached nothing
    fail = false;
    expect(await resolve()).toEqual({ ts: `"public".`, tk: `"public".` });
    expect(await resolve()).toEqual({ ts: `"public".`, tk: `"public".` });
    expect(query).toHaveBeenCalledTimes(2); // the successful answer is cached
  });
});
