// Translate a Prisma `where` input into a parameterized SQL boolean expression for the
// timeBucket query. Values are always bound as parameters; column names are resolved +
// identifier-checked, so the result is injection-safe.
//
// Supported: equals, not (incl. nested `not: { ... }`), in, notIn, lt, lte, gt, gte, contains,
// startsWith, endsWith (+ mode: "insensitive"), null checks, shorthand equality, AND / OR / NOT,
// and relation filters (some/none/every/is/isNot) via EXISTS subqueries when relation metadata
// is provided. Unsupported (throws): any operator not in the list above, and nested relation
// filters (a relation filter inside another relation's inner where).
import { assertSafeIdent, quoteIdent } from "../core/sql.js";

export interface WhereCtx {
  /** Resolve a Prisma field name to a quoted DB column (e.g. `deviceId` -> `"device_id"`). */
  col: (field: string) => string;
  /** Bind a value as a parameter and return its placeholder (e.g. `$4`). */
  push: (value: unknown) => string;
  /** Relation-filter support; absent => relation keys fall through to the unsupported-operator error. */
  rel?: {
    /** The current (outer) table, already quoted/qualified, for the EXISTS join (e.g. `"public"."Reading"`). */
    outerTable: string;
    /** Look up a relation by Prisma field name; undefined if `field` is not a relation. */
    get: (field: string) => RuntimeRelation | undefined;
  };
}

/** Runtime view of a relation, for building EXISTS subqueries. Names are DB names. */
export interface RuntimeRelation {
  /** Related table, quoted/qualified (e.g. `"public"."Device"`). */
  table: string;
  /** true => to-many (some/none/every); false => to-one (is/isNot). */
  list: boolean;
  /** Join pairs: `related.<related> = outer.<outer>` (unquoted DB column names). */
  on: readonly { related: string; outer: string }[];
  /** Related Prisma field name -> DB column, for the inner where (@map). */
  columns?: Record<string, string>;
  /** Outer FK column(s) (DB names) for `is`/`isNot: null` (optional to-one only). */
  fk?: readonly string[];
}

const SUPPORTED = "equals, not, in, notIn, lt, lte, gt, gte, contains, startsWith, endsWith";

/** Build a SQL boolean expression from a Prisma where input. Returns "" when there is no filter. */
export function whereToSql(where: Record<string, unknown> | undefined, ctx: WhereCtx): string {
  if (!where) return "";
  const clauses: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "AND") {
      const s = combine(asArray(value), ctx, "AND");
      if (s) clauses.push(s);
    } else if (key === "OR") {
      const s = combine(asArray(value), ctx, "OR");
      if (s) clauses.push(s);
    } else if (key === "NOT") {
      const s = combine(asArray(value), ctx, "AND");
      if (s) clauses.push(`NOT (${s})`);
    } else {
      const relation = ctx.rel?.get(key);
      const s = relation ? relationClause(key, value, relation, ctx) : fieldClause(key, value, ctx);
      if (s) clauses.push(s);
    }
  }
  return clauses.join(" AND ");
}

/**
 * Build the EXISTS / NOT EXISTS clause for a relation filter (some/none/every/is/isNot or a
 * to-one shorthand). The inner filter is resolved against the related table (aliased `_rel`) by
 * recursing through whereToSql with a related-column context — so all scalar operators (incl.
 * nested not) work inside it. Mirrors Prisma's findMany results, including `every`'s vacuous
 * truth and `isNot`/`none` including the no-related-record case (verified against Prisma).
 */
function relationClause(field: string, value: unknown, rel: RuntimeRelation, ctx: WhereCtx): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`timeBucket: relation filter on "${field}" must be an object (some/none/every/is/isNot).`);
  }
  const filter = value as Record<string, unknown>;
  const alias = quoteIdent("_rel");
  const outer = ctx.rel!.outerTable;

  // Inner where resolves against the related table; params are shared; no nested relation filters.
  const innerCtx: WhereCtx = {
    push: ctx.push,
    col: (f) => {
      const c = rel.columns?.[f] ?? f;
      assertSafeIdent(c, "relation column");
      return `${alias}.${quoteIdent(c)}`;
    },
  };
  const join = rel.on.map((p) => `${alias}.${quoteIdent(p.related)} = ${outer}.${quoteIdent(p.outer)}`).join(" AND ");
  const from = `${rel.table} AS ${alias}`;

  // EXISTS (SELECT 1 FROM related AS _rel WHERE join AND (inner)); inner "" -> TRUE. `every` negates
  // the inner (NOT EXISTS where a related row fails it). `negate` wraps the whole thing in NOT.
  const exists = (negate: boolean, negateInner: boolean, inner: unknown): string => {
    let innerSql = whereToSql(inner as Record<string, unknown> | undefined, innerCtx) || "TRUE";
    if (negateInner) innerSql = `NOT (${innerSql})`;
    const sub = `EXISTS (SELECT 1 FROM ${from} WHERE ${join} AND (${innerSql}))`;
    return negate ? `NOT ${sub}` : sub;
  };
  // `is`/`isNot: null` — optional to-one uses the FK column; a relation with no local FK falls
  // back to existence (is: null => no related row).
  const nullCheck = (negate: boolean): string => {
    if (rel.fk && rel.fk.length > 0) {
      const cond = rel.fk.map((c) => `${outer}.${quoteIdent(c)} IS ${negate ? "NOT NULL" : "NULL"}`).join(" AND ");
      return rel.fk.length > 1 ? `(${cond})` : cond;
    }
    const sub = `EXISTS (SELECT 1 FROM ${from} WHERE ${join})`;
    return negate ? sub : `NOT ${sub}`;
  };

  const parts: string[] = [];
  if (rel.list) {
    for (const [op, inner] of Object.entries(filter)) {
      if (inner === undefined) continue;
      if (op === "some") parts.push(exists(false, false, inner));
      else if (op === "none") parts.push(exists(true, false, inner));
      else if (op === "every") parts.push(exists(true, true, inner));
      else throw new Error(`timeBucket: unsupported list relation filter "${op}" on "${field}" (use some / none / every).`);
    }
  } else if ("is" in filter || "isNot" in filter) {
    for (const [op, inner] of Object.entries(filter)) {
      if (inner === undefined) continue;
      if (op === "is") parts.push(inner === null ? nullCheck(false) : exists(false, false, inner));
      else if (op === "isNot") parts.push(inner === null ? nullCheck(true) : exists(true, false, inner));
      else throw new Error(`timeBucket: unsupported to-one relation filter "${op}" on "${field}" (use is / isNot).`);
    }
  } else {
    // to-one shorthand: the whole object is the related where (equivalent to `is`).
    parts.push(exists(false, false, filter));
  }
  return parts.length > 1 ? `(${parts.join(" AND ")})` : (parts[0] ?? "");
}

function combine(wheres: unknown[], ctx: WhereCtx, op: "AND" | "OR"): string {
  const parts = wheres.map((w) => whereToSql(w as Record<string, unknown>, ctx)).filter(Boolean);
  // Prisma semantics: an empty OR matches nothing; an empty AND (also used for NOT) imposes
  // no constraint.
  if (parts.length === 0) return op === "OR" ? "false" : "";
  if (parts.length === 1) return parts[0]!;
  return `(${parts.join(` ${op} `)})`;
}

function fieldClause(field: string, value: unknown, ctx: WhereCtx): string {
  const c = ctx.col(field);
  if (value === null) return `${c} IS NULL`;
  if (isScalar(value)) return `${c} = ${ctx.push(value)}`;
  if (Array.isArray(value)) {
    throw new Error(`timeBucket: unsupported array filter on "${field}".`);
  }
  return operatorMapToSql(c, field, value as Record<string, unknown>, ctx);
}

/** AND together every operator clause in a filter object (e.g. `{ gte, lt }`). `mode` applies to LIKE ops. */
function operatorMapToSql(col: string, field: string, filter: Record<string, unknown>, ctx: WhereCtx): string {
  const mode = filter["mode"] === "insensitive" ? "insensitive" : undefined;
  const parts: string[] = [];
  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined || op === "mode") continue;
    const clause = operatorClause(col, field, op, v, mode, ctx);
    if (clause) parts.push(clause); // skip empties (e.g. an empty nested `not`) so the AND join stays valid
  }
  return parts.join(" AND ");
}

function operatorClause(
  col: string,
  field: string,
  op: string,
  v: unknown,
  mode: "insensitive" | undefined,
  ctx: WhereCtx,
): string {
  switch (op) {
    case "equals":
      return v === null ? `${col} IS NULL` : `${col} = ${ctx.push(scalar(v, field, op))}`;
    case "not":
      if (v === null) return `${col} IS NOT NULL`;
      if (isScalar(v)) return `${col} <> ${ctx.push(v)}`;
      if (Array.isArray(v)) {
        throw new Error(`timeBucket: "not" on "${field}" cannot be an array — use { not: { in: [...] } } or notIn.`);
      }
      // Negate a nested filter object. NOT (...) reproduces Prisma's findMany semantics exactly,
      // including NULL handling: under negation NULL rows are excluded (SQL three-valued logic —
      // NOT(unknown) is unknown — verified against Prisma). Recurses for deeper nesting. An empty
      // inner filter (`not: {}` / only `mode`) is a no-op (like an empty top-level NOT), not `NOT ()`.
      {
        const inner = operatorMapToSql(col, field, v as Record<string, unknown>, ctx);
        return inner ? `NOT (${inner})` : "";
      }
    case "in":
      return inClause(col, v, false, field, ctx);
    case "notIn":
      return inClause(col, v, true, field, ctx);
    case "lt":
      return `${col} < ${ctx.push(scalar(v, field, op))}`;
    case "lte":
      return `${col} <= ${ctx.push(scalar(v, field, op))}`;
    case "gt":
      return `${col} > ${ctx.push(scalar(v, field, op))}`;
    case "gte":
      return `${col} >= ${ctx.push(scalar(v, field, op))}`;
    case "contains":
    case "startsWith":
    case "endsWith":
      return likeClause(col, op, v, mode, field, ctx);
    default:
      throw new Error(
        `timeBucket: unsupported where operator "${op}" on "${field}" (supported: ${SUPPORTED}; relation filters are not supported).`,
      );
  }
}

function inClause(col: string, v: unknown, negate: boolean, field: string, ctx: WhereCtx): string {
  if (!Array.isArray(v)) {
    throw new Error(`timeBucket: "${negate ? "notIn" : "in"}" on "${field}" requires an array.`);
  }
  if (v.length === 0) return negate ? "true" : "false";
  const list = v.map((x) => ctx.push(x)).join(", ");
  return `${col} ${negate ? "NOT IN" : "IN"} (${list})`;
}

function likeClause(
  col: string,
  kind: "contains" | "startsWith" | "endsWith",
  v: unknown,
  mode: "insensitive" | undefined,
  field: string,
  ctx: WhereCtx,
): string {
  if (typeof v !== "string") {
    throw new Error(`timeBucket: "${kind}" on "${field}" requires a string.`);
  }
  // Escape LIKE wildcards/escape char in the user value; the pattern is bound as a param.
  const escaped = v.replace(/([\\%_])/g, "\\$1");
  const pattern = kind === "contains" ? `%${escaped}%` : kind === "startsWith" ? `${escaped}%` : `%${escaped}`;
  const operator = mode === "insensitive" ? "ILIKE" : "LIKE";
  return `${col} ${operator} ${ctx.push(pattern)} ESCAPE '\\'`;
}

function isScalar(v: unknown): boolean {
  return v instanceof Date || typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint";
}

function scalar(v: unknown, field: string, op: string): unknown {
  if (v === null || !isScalar(v)) {
    throw new Error(`timeBucket: "${op}" on "${field}" requires a scalar value.`);
  }
  return v;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}
