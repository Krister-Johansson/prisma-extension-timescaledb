import { describe, expect, it } from "vitest";
import { whereToSql, type WhereCtx } from "../../src/client/where.js";

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

  it("throws on unsupported operator, relation filter, and nested not", () => {
    expect(() => whereToSql({ deviceId: { foo: 1 } }, harness().ctx)).toThrow(/unsupported where operator "foo"/);
    expect(() => whereToSql({ author: { some: {} } }, harness().ctx)).toThrow(/unsupported where operator "some"/);
    expect(() => whereToSql({ deviceId: { not: { gt: 1 } } }, harness().ctx)).toThrow(/nested "not"/);
  });
});
