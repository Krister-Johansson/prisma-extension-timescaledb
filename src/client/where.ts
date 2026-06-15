// Translate a Prisma `where` input into a parameterized SQL boolean expression for the
// single-table timeBucket query. Values are always bound as parameters; column names are
// resolved + identifier-checked by the caller, so the result is injection-safe.
//
// Supported: equals, not, in, notIn, lt, lte, gt, gte, contains, startsWith, endsWith
// (+ mode: "insensitive"), null checks, shorthand equality, and AND / OR / NOT.
// Unsupported (throws): relation filters (some/none/every), nested `not: {...}`, and any
// operator not in the list above.

export interface WhereCtx {
  /** Resolve a Prisma field name to a quoted DB column (e.g. `deviceId` -> `"device_id"`). */
  col: (field: string) => string;
  /** Bind a value as a parameter and return its placeholder (e.g. `$4`). */
  push: (value: unknown) => string;
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
      const s = fieldClause(key, value, ctx);
      if (s) clauses.push(s);
    }
  }
  return clauses.join(" AND ");
}

function combine(wheres: unknown[], ctx: WhereCtx, op: "AND" | "OR"): string {
  const parts = wheres.map((w) => whereToSql(w as Record<string, unknown>, ctx)).filter(Boolean);
  if (parts.length === 0) return "";
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

  const filter = value as Record<string, unknown>;
  const mode = filter["mode"] === "insensitive" ? "insensitive" : undefined;
  const parts: string[] = [];
  for (const [op, v] of Object.entries(filter)) {
    if (v === undefined || op === "mode") continue;
    parts.push(operatorClause(c, field, op, v, mode, ctx));
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
      throw new Error(`timeBucket: nested "not" filter on "${field}" is not supported.`);
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
