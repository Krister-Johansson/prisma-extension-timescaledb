import { describe, expect, it } from "vitest";
import { whereToSql, type RuntimeRelation, type WhereCtx } from "../../src/client/where.js";

function harness() {
  const params: unknown[] = [];
  const ctx: WhereCtx = {
    col: (f) => `"${f}"`,
    push: (v) => {
      params.push(v);
      return `$${params.length}`;
    },
  };
  return { ctx, params };
}

function relHarness() {
  const params: unknown[] = [];
  const device: RuntimeRelation = {
    table: `"public"."Device"`,
    list: false,
    on: [{ related: "id", outer: "deviceId" }],
    fk: ["deviceId"],
  };
  const tags: RuntimeRelation = { table: `"public"."Tag"`, list: true, on: [{ related: "readingId", outer: "id" }] };
  const relations = new Map<string, RuntimeRelation>([
    ["device", device],
    ["tags", tags],
  ]);
  const ctx: WhereCtx = {
    col: (f) => `"${f}"`,
    push: (v) => {
      params.push(v);
      return `$${params.length}`;
    },
    rel: { outerTable: `"public"."Reading"`, get: (f) => relations.get(f) },
  };
  return { ctx, params };
}

describe("whereToSql", () => {
  it("returns empty for undefined / {}", () => {
    expect(whereToSql(undefined, harness().ctx)).toBe("");
    expect(whereToSql({}, harness().ctx)).toBe("");
  });

  it("shorthand equality binds the value", () => {
    const { ctx, params } = harness();
    expect(whereToSql({ deviceId: 1 }, ctx)).toBe(`"deviceId" = $1`);
    expect(params).toEqual([1]);
  });

  it("null -> IS NULL", () => {
    expect(whereToSql({ label: null }, harness().ctx)).toBe(`"label" IS NULL`);
  });

  it("comparison operators on one field AND together", () => {
    const { ctx, params } = harness();
    expect(whereToSql({ temperature: { gte: 20, lt: 30 } }, ctx)).toBe(`"temperature" >= $1 AND "temperature" < $2`);
    expect(params).toEqual([20, 30]);
  });

  it("in / notIn", () => {
    const a = harness();
    expect(whereToSql({ deviceId: { in: [1, 2, 3] } }, a.ctx)).toBe(`"deviceId" IN ($1, $2, $3)`);
    expect(a.params).toEqual([1, 2, 3]);
    expect(whereToSql({ deviceId: { notIn: [9] } }, harness().ctx)).toBe(`"deviceId" NOT IN ($1)`);
  });

  it("empty in -> false, empty notIn -> true", () => {
    expect(whereToSql({ deviceId: { in: [] } }, harness().ctx)).toBe("false");
    expect(whereToSql({ deviceId: { notIn: [] } }, harness().ctx)).toBe("true");
  });

  it("not value / not null", () => {
    expect(whereToSql({ deviceId: { not: 5 } }, harness().ctx)).toBe(`"deviceId" <> $1`);
    expect(whereToSql({ label: { not: null } }, harness().ctx)).toBe(`"label" IS NOT NULL`);
  });

  it("string contains/startsWith/endsWith escape wildcards; mode -> ILIKE", () => {
    const a = harness();
    expect(whereToSql({ label: { contains: "a%b" } }, a.ctx)).toBe(`"label" LIKE $1 ESCAPE '\\'`);
    expect(a.params).toEqual(["%a\\%b%"]);
    const b = harness();
    expect(whereToSql({ label: { startsWith: "x", mode: "insensitive" } }, b.ctx)).toBe(`"label" ILIKE $1 ESCAPE '\\'`);
    expect(b.params).toEqual(["x%"]);
    expect(whereToSql({ label: { endsWith: "z" } }, harness().ctx)).toBe(`"label" LIKE $1 ESCAPE '\\'`);
  });

  it("AND / OR / NOT", () => {
    expect(whereToSql({ AND: [{ deviceId: 1 }, { temperature: { gte: 20 } }] }, harness().ctx)).toBe(
      `("deviceId" = $1 AND "temperature" >= $2)`,
    );
    expect(whereToSql({ OR: [{ deviceId: 1 }, { deviceId: 2 }] }, harness().ctx)).toBe(
      `("deviceId" = $1 OR "deviceId" = $2)`,
    );
    expect(whereToSql({ NOT: { deviceId: 1 } }, harness().ctx)).toBe(`NOT ("deviceId" = $1)`);
  });

  it("empty OR matches nothing (false); empty AND / NOT impose no constraint", () => {
    expect(whereToSql({ OR: [] }, harness().ctx)).toBe("false");
    expect(whereToSql({ AND: [] }, harness().ctx)).toBe("");
    expect(whereToSql({ NOT: [] }, harness().ctx)).toBe("");
  });

  it("multiple top-level fields AND together", () => {
    expect(whereToSql({ deviceId: 1, temperature: { gt: 0 } }, harness().ctx)).toBe(
      `"deviceId" = $1 AND "temperature" > $2`,
    );
  });

  it("nested not negates the inner filter as NOT (...) (matches Prisma; NULLs excluded)", () => {
    const a = harness();
    expect(whereToSql({ deviceId: { not: { in: [1, 2] } } }, a.ctx)).toBe(`NOT ("deviceId" IN ($1, $2))`);
    expect(a.params).toEqual([1, 2]);

    const b = harness();
    expect(whereToSql({ temperature: { not: { gte: 30 } } }, b.ctx)).toBe(`NOT ("temperature" >= $1)`);
    expect(b.params).toEqual([30]);

    // multiple inner operators are ANDed inside the negation
    const c = harness();
    expect(whereToSql({ temperature: { not: { gte: 20, lt: 30 } } }, c.ctx)).toBe(
      `NOT ("temperature" >= $1 AND "temperature" < $2)`,
    );
    expect(c.params).toEqual([20, 30]);

    // a LIKE op + mode inside not
    const d = harness();
    expect(whereToSql({ label: { not: { contains: "x", mode: "insensitive" } } }, d.ctx)).toBe(
      `NOT ("label" ILIKE $1 ESCAPE '\\')`,
    );
    expect(d.params).toEqual(["%x%"]);
  });

  it("empty nested not (not: {} or only mode) is a no-op, never NOT ()", () => {
    expect(whereToSql({ deviceId: { not: {} } }, harness().ctx)).toBe("");
    expect(whereToSql({ label: { not: { mode: "insensitive" } } }, harness().ctx)).toBe("");
    // combined with a real operator on the same field, the empty not simply drops out
    const a = harness();
    expect(whereToSql({ temperature: { not: {}, gte: 5 } }, a.ctx)).toBe(`"temperature" >= $1`);
    expect(a.params).toEqual([5]);
  });

  it("throws on unsupported operators, relation filters (incl. inside not), and not: [array]", () => {
    expect(() => whereToSql({ deviceId: { foo: 1 } }, harness().ctx)).toThrow(/unsupported where operator "foo"/);
    expect(() => whereToSql({ author: { some: {} } }, harness().ctx)).toThrow(/unsupported where operator "some"/);
    // relation filters nested inside not still throw clearly
    expect(() => whereToSql({ author: { not: { some: {} } } }, harness().ctx)).toThrow(
      /unsupported where operator "some"/,
    );
    expect(() => whereToSql({ deviceId: { not: [1, 2] } }, harness().ctx)).toThrow(/cannot be an array/);
  });
});

describe("whereToSql relation filters (EXISTS)", () => {
  const exists = (negate: boolean, table: string, join: string, inner: string) =>
    `${negate ? "NOT " : ""}EXISTS (SELECT 1 FROM ${table} AS "_rel" WHERE ${join} AND (${inner}))`;
  const dev = `"_rel"."id" = "public"."Reading"."deviceId"`;
  const tag = `"_rel"."readingId" = "public"."Reading"."id"`;

  it("to-one is / isNot / shorthand build EXISTS / NOT EXISTS", () => {
    const a = relHarness();
    expect(whereToSql({ device: { is: { active: true } } }, a.ctx)).toBe(
      exists(false, `"public"."Device"`, dev, `"_rel"."active" = $1`),
    );
    expect(a.params).toEqual([true]);
    expect(whereToSql({ device: { isNot: { active: true } } }, relHarness().ctx)).toBe(
      exists(true, `"public"."Device"`, dev, `"_rel"."active" = $1`),
    );
    // shorthand (no is/isNot) == is
    expect(whereToSql({ device: { active: true } }, relHarness().ctx)).toBe(
      exists(false, `"public"."Device"`, dev, `"_rel"."active" = $1`),
    );
  });

  it("to-one is/isNot null use the FK column", () => {
    expect(whereToSql({ device: { is: null } }, relHarness().ctx)).toBe(`"public"."Reading"."deviceId" IS NULL`);
    expect(whereToSql({ device: { isNot: null } }, relHarness().ctx)).toBe(`"public"."Reading"."deviceId" IS NOT NULL`);
  });

  it("to-many some / none / every (every negates the inner)", () => {
    const a = relHarness();
    expect(whereToSql({ tags: { some: { label: "x" } } }, a.ctx)).toBe(
      exists(false, `"public"."Tag"`, tag, `"_rel"."label" = $1`),
    );
    expect(a.params).toEqual(["x"]);
    expect(whereToSql({ tags: { none: { label: "x" } } }, relHarness().ctx)).toBe(
      exists(true, `"public"."Tag"`, tag, `"_rel"."label" = $1`),
    );
    expect(whereToSql({ tags: { every: { label: "x" } } }, relHarness().ctx)).toBe(
      exists(true, `"public"."Tag"`, tag, `NOT ("_rel"."label" = $1)`),
    );
  });

  it("empty inner becomes TRUE (some {} = has any; every {} = all)", () => {
    expect(whereToSql({ tags: { some: {} } }, relHarness().ctx)).toBe(exists(false, `"public"."Tag"`, tag, "TRUE"));
    expect(whereToSql({ tags: { every: {} } }, relHarness().ctx)).toBe(
      exists(true, `"public"."Tag"`, tag, `NOT (TRUE)`),
    );
  });

  it("reuses scalar machinery (incl. nested not) inside the related filter", () => {
    const a = relHarness();
    expect(whereToSql({ tags: { some: { label: { not: { in: ["x", "y"] } } } } }, a.ctx)).toBe(
      exists(false, `"public"."Tag"`, tag, `NOT ("_rel"."label" IN ($1, $2))`),
    );
    expect(a.params).toEqual(["x", "y"]);
  });

  it("relation filters compose with AND/OR and scalar filters", () => {
    const a = relHarness();
    expect(whereToSql({ deviceId: { gt: 0 }, tags: { some: { label: "x" } } }, a.ctx)).toBe(
      `"deviceId" > $1 AND ${exists(false, `"public"."Tag"`, tag, `"_rel"."label" = $2`)}`,
    );
    expect(a.params).toEqual([0, "x"]);
  });

  it("throws on a bad list operator, and on nesting when the related model's relations are unregistered", () => {
    expect(() => whereToSql({ tags: { has: {} } }, relHarness().ctx)).toThrow(/unsupported list relation filter "has"/);
    // relHarness has no `relationsOf`, so a relation filter inside the related where can't resolve
    // and falls through to the scalar-operator error (the one-level fallback for old configs).
    expect(() => whereToSql({ device: { is: { tags: { some: {} } } } }, relHarness().ctx)).toThrow(
      /unsupported where operator "some"/,
    );
  });
});

// A registry-style harness with `relationsOf` + `targetModel`, enabling relation filters nested
// through other relations. Reading -> device (Device, to-one) / tags (Tag, to-many);
// Device -> readings (Reading, to-many); Tag -> reading (Reading, to-one).
function nestedRelHarness() {
  const params: unknown[] = [];
  const byModel = new Map<string, Map<string, RuntimeRelation>>([
    [
      "Reading",
      new Map<string, RuntimeRelation>([
        ["device", { table: `"public"."Device"`, list: false, on: [{ related: "id", outer: "deviceId" }], fk: ["deviceId"], targetModel: "Device" }],
        ["tags", { table: `"public"."Tag"`, list: true, on: [{ related: "readingId", outer: "id" }], targetModel: "Tag" }],
      ]),
    ],
    ["Device", new Map<string, RuntimeRelation>([["readings", { table: `"public"."Reading"`, list: true, on: [{ related: "deviceId", outer: "id" }], targetModel: "Reading" }]])],
    ["Tag", new Map<string, RuntimeRelation>([["reading", { table: `"public"."Reading"`, list: false, on: [{ related: "id", outer: "readingId" }], fk: ["readingId"], targetModel: "Reading" }]])],
  ]);
  const relationsOf = (m: string) => {
    const fm = byModel.get(m);
    return fm ? (f: string) => fm.get(f) : undefined;
  };
  const ctx: WhereCtx = {
    col: (f) => `"${f}"`,
    push: (v) => {
      params.push(v);
      return `$${params.length}`;
    },
    rel: { outerTable: `"public"."Reading"`, get: (f) => byModel.get("Reading")!.get(f), depth: 0, relationsOf },
  };
  return { ctx, params };
}

describe("whereToSql nested relation filters (multi-level EXISTS)", () => {
  it("nests a to-many filter inside a to-one, correlating the inner alias to the outer", () => {
    const { ctx, params } = nestedRelHarness();
    expect(whereToSql({ device: { is: { readings: { some: { deviceId: 1 } } } } }, ctx)).toBe(
      `EXISTS (SELECT 1 FROM "public"."Device" AS "_rel" WHERE "_rel"."id" = "public"."Reading"."deviceId" AND (` +
        `EXISTS (SELECT 1 FROM "public"."Reading" AS "_rel2" WHERE "_rel2"."deviceId" = "_rel"."id" AND ("_rel2"."deviceId" = $1))))`,
    );
    expect(params).toEqual([1]);
  });

  it("nests three levels with distinct aliases, each correlated to the level above", () => {
    const { ctx, params } = nestedRelHarness();
    const sql = whereToSql({ tags: { some: { reading: { is: { device: { is: { active: true } } } } } } }, ctx);
    expect(sql).toContain(`FROM "public"."Tag" AS "_rel"`);
    expect(sql).toContain(`FROM "public"."Reading" AS "_rel2"`);
    expect(sql).toContain(`FROM "public"."Device" AS "_rel3"`);
    expect(sql).toContain(`"_rel"."readingId" = "public"."Reading"."id"`);
    expect(sql).toContain(`"_rel2"."id" = "_rel"."readingId"`);
    expect(sql).toContain(`"_rel3"."id" = "_rel2"."deviceId"`);
    expect(sql).toContain(`"_rel3"."active" = $1`);
    expect(params).toEqual([true]);
  });

  it("composes nested none with the outer EXISTS (negation wraps the inner subquery)", () => {
    const { ctx } = nestedRelHarness();
    expect(whereToSql({ device: { is: { readings: { none: { deviceId: 1 } } } } }, ctx)).toContain(
      `AND (NOT EXISTS (SELECT 1 FROM "public"."Reading" AS "_rel2"`,
    );
  });

  it("still throws when a key inside a registered nest is not a relation of that model", () => {
    const { ctx } = nestedRelHarness();
    expect(() => whereToSql({ device: { is: { bogus: { some: {} } } } }, ctx)).toThrow(
      /unsupported where operator "some"/,
    );
  });
});
