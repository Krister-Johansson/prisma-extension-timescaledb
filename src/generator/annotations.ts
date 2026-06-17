// Pure parser for `@timescale.*` annotations found in Prisma `///` documentation strings.
// NO DMMF dependency — it only turns a doc string into a structured annotation list. The
// DMMF layer (dmmf.ts) decides what the annotations mean and validates them.
//
// Grammar (informal):
//   @timescale.<name>                       -> { name, args: {} }
//   @timescale.<name>(<key>: <value>, ...)  -> { name, args }
//   value := "string" | { <key>: <value>, ... } | bare-token
//
// Examples:
//   @timescale.hypertable(column: "time", chunkInterval: "1 day")
//   @timescale.continuousAggregate(source: "X", refresh: { startOffset: "1 month" })
//   @timescale.bucket
//   @timescale.aggregate(fn: "avg", column: "temperature")

export type AnnotationValue = string | AnnotationArgs;
export interface AnnotationArgs {
  [key: string]: AnnotationValue;
}
export interface ParsedAnnotation {
  name: string;
  args: AnnotationArgs;
}

const NAME_RE = /@timescale\.([A-Za-z][A-Za-z0-9]*)/g;
const ENTRY_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:([\s\S]*)$/;

/** Parse every `@timescale.*` annotation out of a documentation string. */
export function parseAnnotations(doc: string | null | undefined): ParsedAnnotation[] {
  if (!doc) return [];
  const out: ParsedAnnotation[] = [];
  NAME_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAME_RE.exec(doc)) !== null) {
    const name = match[1];
    if (name === undefined) continue;

    let args: AnnotationArgs = {};
    let i = NAME_RE.lastIndex;
    while (i < doc.length && /\s/.test(doc[i] ?? "")) i++;
    if (doc[i] === "(") {
      const { body, end } = readBalanced(doc, i, "(", ")");
      args = parseArgs(body);
      NAME_RE.lastIndex = end;
    }
    out.push({ name, args });
  }
  return out;
}

/** Find the first annotation with a given name, or undefined. */
export function findAnnotation(annotations: ParsedAnnotation[], name: string): ParsedAnnotation | undefined {
  return annotations.find((a) => a.name === name);
}

/** Read a string-valued arg, throwing a precise error if missing or not a string. */
export function requireString(args: AnnotationArgs, key: string, context: string): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new Error(`${context}: missing or non-string argument "${key}".`);
  }
  return v;
}

/** Read an optional string-valued arg. */
export function optionalString(args: AnnotationArgs, key: string, context: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new Error(`${context}: argument "${key}" must be a string.`);
  }
  return v;
}

/** Read an optional boolean-valued arg (a bare `true` / `false` token, e.g. `materializedOnly: false`). */
export function optionalBoolean(args: AnnotationArgs, key: string, context: string): boolean | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`${context}: argument "${key}" must be true or false.`);
}

/** Read a nested-object arg, or undefined. */
export function optionalObject(args: AnnotationArgs, key: string, context: string): AnnotationArgs | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v === "string") {
    throw new Error(`${context}: argument "${key}" must be an object.`);
  }
  return v;
}

// --- internals -------------------------------------------------------------

/** Read a balanced (...) or {...} block starting at `open` (the opening bracket index). */
function readBalanced(s: string, open: number, openCh: string, closeCh: string): { body: string; end: number } {
  let depth = 0;
  let inStr = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '"' && s[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === openCh || c === "{" || c === "(") depth++;
    else if (c === closeCh || c === "}" || c === ")") {
      depth--;
      if (depth === 0) return { body: s.slice(open + 1, i), end: i + 1 };
    }
  }
  throw new Error(`Unbalanced ${openCh}${closeCh} in annotation: ${JSON.stringify(s.slice(open))}`);
}

function parseArgs(body: string): AnnotationArgs {
  const args: AnnotationArgs = {};
  for (const entry of splitTopLevel(body)) {
    if (entry.trim() === "") continue;
    const m = ENTRY_RE.exec(entry);
    if (!m || m[1] === undefined || m[2] === undefined) {
      throw new Error(`Malformed annotation argument: ${JSON.stringify(entry.trim())} (expected "key: value").`);
    }
    args[m[1]] = parseValue(m[2]);
  }
  return args;
}

function parseValue(raw: string): AnnotationValue {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const { body, end } = readBalancedString(v);
    if (v.slice(end).trim() !== "") {
      throw new Error(`Malformed annotation value (trailing characters after string): ${JSON.stringify(v)}.`);
    }
    return body.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (v.startsWith("{")) {
    const { body, end } = readBalanced(v, 0, "{", "}");
    if (v.slice(end).trim() !== "") {
      throw new Error(`Malformed annotation value (trailing characters after object): ${JSON.stringify(v)}.`);
    }
    return parseArgs(body);
  }
  return v;
}

/** Read a "double-quoted" string starting at index 0, returning its inner body + the index after the closing quote. */
function readBalancedString(s: string): { body: string; end: number } {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '"' && s[i - 1] !== "\\") return { body: s.slice(1, i), end: i + 1 };
  }
  throw new Error(`Unterminated string in annotation: ${JSON.stringify(s)}`);
}

/** Split on top-level commas, ignoring commas inside strings, (), and {}. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? "";
    if (inStr) {
      cur += c;
      if (c === '"' && s[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      cur += c;
    } else if (c === "{" || c === "(") {
      depth++;
      cur += c;
    } else if (c === "}" || c === ")") {
      depth--;
      cur += c;
    } else if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}
