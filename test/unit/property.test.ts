import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertInterval, isInterval } from "../../src/core/interval.js";
import {
  assertSafeIdent,
  existenceGuard,
  qualifiedIdent,
  quoteIdent,
  quoteLiteral,
  relationLiteral,
  timescaleDoBlock,
} from "../../src/core/sql.js";
import { parseAnnotations, type AnnotationArgs } from "../../src/generator/annotations.js";
import {
  maxObjectsSequence,
  NewerStateFileError,
  OBJECTS_MIGRATION_PREFIX,
  objectsMigrationName,
  parseGeneratorState,
  type GeneratorState,
} from "../../src/generator/emit-migrations.js";

// Property-based tests. Instead of hand-picked examples, fast-check generates hundreds of
// inputs per property and checks an invariant on every one of them. The targets are the pure
// helpers that sit on the SQL interpolation boundary (quoting, interval validation, identifier
// checks) and the parsers that read untrusted text (annotations, the state file, migration
// folder names). Generators are shaped like the input each function really sees, so a failure
// here points at a real bug rather than at an input the code will never meet.

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const LETTERS = LOWER + LOWER.toUpperCase();
const DIGITS = "0123456789";
const IDENT_CHARS = LETTERS + DIGITS + "_";

const charFrom = (chars: string) => fc.constantFrom(...chars.split(""));
const stringFrom = (chars: string, opts: { minLength?: number; maxLength?: number } = {}) =>
  fc.array(charFrom(chars), { maxLength: 16, ...opts }).map((cs) => cs.join(""));

/** `[A-Za-z_][A-Za-z0-9_]*`: what assertSafeIdent accepts and what Prisma model names look like. */
const safeIdentArb = fc
  .tuple(charFrom(LETTERS + "_"), stringFrom(IDENT_CHARS, { maxLength: 12 }))
  .map(([head, tail]) => head + tail);

/** Any non-empty string, so the quoting helpers meet quotes, backslashes and unicode. */
const nonEmptyStringArb = fc.oneof(fc.string({ minLength: 1 }), fc.string({ unit: "binary", minLength: 1 }));

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

describe("property-based invariants", () => {
  describe("quoteIdent / quoteLiteral", () => {
    it("quoteIdent wraps in double quotes and doubles every embedded double quote", () => {
      fc.assert(
        fc.property(nonEmptyStringArb, (name) => {
          const quoted = quoteIdent(name);
          expect(quoted.startsWith('"')).toBe(true);
          expect(quoted.endsWith('"')).toBe(true);
          const inner = quoted.slice(1, -1);
          // Round trip: undoing the escaping recovers the input exactly.
          expect(inner.replace(/""/g, '"')).toBe(name);
          // Every inner quote is part of a pair, so the total quote count is even.
          expect((quoted.match(/"/g) ?? []).length).toBe(2 + 2 * (name.match(/"/g) ?? []).length);
        }),
      );
    });

    it("quoteIdent rejects only the empty identifier", () => {
      expect(() => quoteIdent("")).toThrow(/must not be empty/);
      fc.assert(
        fc.property(nonEmptyStringArb, (name) => {
          expect(() => quoteIdent(name)).not.toThrow();
        }),
      );
    });

    it("quoteLiteral wraps in single quotes and doubles every embedded single quote", () => {
      fc.assert(
        fc.property(fc.string(), (value) => {
          const quoted = quoteLiteral(value);
          expect(quoted.startsWith("'")).toBe(true);
          expect(quoted.endsWith("'")).toBe(true);
          expect(quoted.slice(1, -1).replace(/''/g, "'")).toBe(value);
          expect((quoted.match(/'/g) ?? []).length).toBe(2 + 2 * (value.match(/'/g) ?? []).length);
        }),
      );
    });

    it("a quoted identifier never terminates early: no lone double quote inside the wrapper", () => {
      fc.assert(
        fc.property(nonEmptyStringArb, (name) => {
          const inner = quoteIdent(name).slice(1, -1);
          // Strip every doubled pair; anything left over would end the identifier prematurely.
          expect(inner.replace(/""/g, "")).not.toContain('"');
        }),
      );
    });
  });

  describe("qualifiedIdent / relationLiteral", () => {
    it("qualifiedIdent is quoteIdent when no schema is given, and schema.name otherwise", () => {
      fc.assert(
        fc.property(nonEmptyStringArb, fc.option(nonEmptyStringArb, { nil: undefined }), (name, schema) => {
          const expected = schema === undefined ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`;
          expect(qualifiedIdent(name, schema)).toBe(expected);
        }),
      );
    });

    it("an empty schema is treated as no schema", () => {
      fc.assert(
        fc.property(nonEmptyStringArb, (name) => {
          expect(qualifiedIdent(name, "")).toBe(quoteIdent(name));
          expect(relationLiteral(name, "")).toBe(relationLiteral(name));
        }),
      );
    });

    it("relationLiteral is the quoted-literal form of qualifiedIdent and never carries a cast", () => {
      fc.assert(
        fc.property(nonEmptyStringArb, fc.option(nonEmptyStringArb, { nil: undefined }), (name, schema) => {
          const literal = relationLiteral(name, schema);
          expect(literal).toBe(quoteLiteral(qualifiedIdent(name, schema)));
          // CLAUDE.md constraint 2: the relation goes in as a string literal, never `::regclass`
          // or `::name`. The helper must not add one for any input.
          expect(literal.replace(quoteLiteral(qualifiedIdent(name, schema)), "")).not.toContain("::");
        }),
      );
    });

    it("keeps a safe mixed-case name verbatim inside its inner quotes", () => {
      fc.assert(
        fc.property(safeIdentArb, fc.option(safeIdentArb, { nil: undefined }), (name, schema) => {
          // Mixed-case names must stay quoted or Postgres case-folds them.
          expect(relationLiteral(name, schema)).toContain(`"${name}"`);
          if (schema !== undefined) expect(relationLiteral(name, schema)).toContain(`"${schema}"."${name}"`);
        }),
      );
    });
  });

  describe("assertSafeIdent", () => {
    it("accepts every identifier of the documented shape", () => {
      fc.assert(
        fc.property(safeIdentArb, (name) => {
          expect(() => assertSafeIdent(name)).not.toThrow();
        }),
      );
    });

    it("rejects any string with a character outside letters, digits and underscore", () => {
      const unsafeChar = fc.string({ minLength: 1, maxLength: 1 }).filter((c) => !IDENT_CHARS.includes(c));
      fc.assert(
        fc.property(stringFrom(IDENT_CHARS), unsafeChar, stringFrom(IDENT_CHARS), (before, bad, after) => {
          expect(() => assertSafeIdent(before + bad + after)).toThrow(/Invalid identifier/);
        }),
      );
    });

    it("rejects anything that starts with a digit, and the empty string", () => {
      expect(() => assertSafeIdent("")).toThrow(/Invalid identifier/);
      fc.assert(
        fc.property(charFrom(DIGITS), stringFrom(IDENT_CHARS), (digit, rest) => {
          expect(() => assertSafeIdent(digit + rest)).toThrow(/Invalid identifier/);
        }),
      );
    });

    it("agrees with the documented regular expression on arbitrary strings", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const accepted = (() => {
            try {
              assertSafeIdent(s);
              return true;
            } catch {
              return false;
            }
          })();
          expect(accepted).toBe(SAFE_IDENT.test(s));
        }),
      );
    });

    it("uses the caller's label in the error message", () => {
      fc.assert(
        fc.property(safeIdentArb, (label) => {
          expect(() => assertSafeIdent("not safe", label)).toThrow(`Invalid ${label} `);
        }),
      );
    });
  });

  describe("existenceGuard / timescaleDoBlock", () => {
    const relArb = fc.tuple(safeIdentArb, fc.option(safeIdentArb, { nil: undefined })).map(([n, s]) =>
      relationLiteral(n, s),
    );
    const bodyArb = fc.array(fc.string(), { maxLength: 4 }).map((lines) => lines.join("\n"));

    it("the guard tests the relation with to_regclass, warns, and returns", () => {
      fc.assert(
        fc.property(relArb, (rel) => {
          const guard = existenceGuard(rel);
          expect(guard.startsWith(`IF to_regclass(${rel}) IS NULL THEN`)).toBe(true);
          expect(guard).toContain("RAISE WARNING");
          expect(guard).toContain(`, ${rel}; RETURN;`);
          expect(guard.endsWith("END IF;")).toBe(true);
        }),
      );
    });

    it("a DO block always opens and closes as one plpgsql unit and embeds the body verbatim", () => {
      fc.assert(
        fc.property(bodyArb, fc.option(relArb, { nil: undefined }), (body, guardRel) => {
          const block = timescaleDoBlock(body, guardRel);
          expect(block.startsWith("DO $$\nDECLARE ts_schema text;\nBEGIN\n")).toBe(true);
          expect(block.endsWith("\nEND $$;")).toBe(true);
          expect(block).toContain(`\n${body}\n`);
        }),
      );
    });

    it("the existence guard is present exactly when a relation is given, and runs before the search path", () => {
      fc.assert(
        fc.property(bodyArb, fc.option(relArb, { nil: undefined }), (body, guardRel) => {
          const block = timescaleDoBlock(body, guardRel);
          const guardAt = block.indexOf("IF to_regclass(");
          const searchPathAt = block.indexOf("set_config('search_path'");
          expect(searchPathAt).toBeGreaterThan(-1);
          if (guardRel === undefined) {
            expect(guardAt).toBe(-1);
          } else {
            expect(block).toContain(existenceGuard(guardRel));
            // The guard's RETURN must never leave a half-applied search path behind.
            expect(guardAt).toBeGreaterThan(-1);
            expect(guardAt).toBeLessThan(searchPathAt);
          }
        }),
      );
    });
  });

  describe("isInterval / assertInterval", () => {
    // Mirrors the PostgreSQL interval input units in src/core/interval.ts.
    const UNITS = [
      "microsecond",
      "microseconds",
      "millisecond",
      "milliseconds",
      "second",
      "seconds",
      "minute",
      "minutes",
      "hour",
      "hours",
      "day",
      "days",
      "week",
      "weeks",
      "month",
      "months",
      "year",
      "years",
      "decade",
      "decades",
      "century",
      "centuries",
    ];
    const unitArb = fc.constantFrom(...UNITS);
    // `<digits>[.<digits>]`, built from the parts so positivity is known without parsing.
    const amountArb = fc
      .tuple(fc.nat({ max: 100_000 }), fc.option(fc.nat({ max: 9_999 }), { nil: undefined }))
      .map(([whole, frac]) => ({
        text: frac === undefined ? String(whole) : `${whole}.${frac}`,
        positive: whole > 0 || (frac ?? 0) > 0,
      }));

    it("accepts every `<amount> <unit>` with a positive amount, and rejects a zero amount", () => {
      fc.assert(
        fc.property(amountArb, unitArb, (amount, unit) => {
          const value = `${amount.text} ${unit}`;
          expect(isInterval(value)).toBe(amount.positive);
        }),
      );
    });

    it("assertInterval throws exactly when isInterval is false", () => {
      fc.assert(
        fc.property(fc.oneof(fc.string(), fc.tuple(amountArb, unitArb).map(([a, u]) => `${a.text} ${u}`)), (value) => {
          if (isInterval(value)) {
            expect(() => assertInterval(value)).not.toThrow();
          } else {
            expect(() => assertInterval(value)).toThrow(/Invalid interval/);
          }
        }),
      );
    });

    it("rejects a sign, extra whitespace, changed case, and unknown units", () => {
      const positiveAmount = amountArb.filter((a) => a.positive);
      fc.assert(
        fc.property(positiveAmount, unitArb, (amount, unit) => {
          expect(isInterval(`-${amount.text} ${unit}`)).toBe(false);
          expect(isInterval(`+${amount.text} ${unit}`)).toBe(false);
          expect(isInterval(`${amount.text}  ${unit}`)).toBe(false);
          expect(isInterval(` ${amount.text} ${unit}`)).toBe(false);
          expect(isInterval(`${amount.text} ${unit} `)).toBe(false);
          expect(isInterval(`${amount.text}${unit}`)).toBe(false);
          expect(isInterval(`${amount.text} ${unit.toUpperCase()}`)).toBe(false);
          expect(isInterval(`${amount.text} ${unit}x`)).toBe(false);
        }),
      );
      for (const notAUnit of ["quarter", "quarters", "millennium", "millennia", "h", "min", "d"]) {
        expect(isInterval(`1 ${notAUnit}`)).toBe(false);
      }
    });

    it("never accepts a value carrying a quote or a semicolon (the SQL interpolation vector)", () => {
      const withInjection = fc
        .tuple(fc.string(), fc.constantFrom("'", ";", "--", "\n"), fc.string())
        .map(([a, sep, b]) => a + sep + b);
      fc.assert(
        fc.property(withInjection, (value) => {
          expect(isInterval(value)).toBe(false);
        }),
      );
    });
  });

  describe("parseAnnotations", () => {
    const annotationNameArb = fc
      .tuple(charFrom(LETTERS), stringFrom(LETTERS + DIGITS, { maxLength: 10 }))
      .map(([head, tail]) => head + tail);
    // Quoted string values, including the two escapable characters: a value is written as
    // `"..."` with `\\` and `"` escaped by a backslash, and must come back byte for byte (#151).
    const quotedValueArb = stringFrom(LETTERS + DIGITS + " ,:(){}.-_/'\\\"", { maxLength: 12 });
    const escape = (v: string) => v.replace(/[\\"]/g, (c) => `\\${c}`);
    const bareValueArb = fc.oneof(fc.constantFrom("true", "false"), stringFrom(LETTERS + DIGITS, { minLength: 1 }));
    const flatArgsArb = fc.dictionary(safeIdentArb, fc.oneof(quotedValueArb, bareValueArb), {
      maxKeys: 4,
    });
    const nestedArgsArb: fc.Arbitrary<AnnotationArgs> = fc.dictionary(
      safeIdentArb,
      fc.oneof(quotedValueArb, bareValueArb, flatArgsArb),
      { maxKeys: 4 },
    );

    /** Render args the way a user writes them, tracking which values were quoted. */
    function renderArgs(args: AnnotationArgs, quotedKeys: Set<string>): string {
      return Object.entries(args)
        .map(([k, v]) => {
          if (typeof v === "string") {
            return quotedKeys.has(k) || !/^[A-Za-z0-9]+$/.test(v) ? `${k}: "${escape(v)}"` : `${k}: ${v}`;
          }
          return `${k}: { ${renderArgs(v, quotedKeys)} }`;
        })
        .join(", ");
    }

    const annotationArb = fc
      .tuple(annotationNameArb, fc.option(nestedArgsArb, { nil: undefined }))
      .map(([name, args]) => ({
        name,
        args: args ?? {},
        text: args === undefined ? `@timescale.${name}` : `@timescale.${name}(${renderArgs(args, new Set())})`,
      }));

    // Doc prose that can never be read as an annotation marker or as an argument list.
    const proseArb = stringFrom(LETTERS + DIGITS + " .,;:-_'\"/", { maxLength: 24 });

    it("returns nothing for text without the marker", () => {
      fc.assert(
        fc.property(
          fc.string().filter((s) => !s.includes("@timescale.")),
          (doc) => {
            expect(parseAnnotations(doc)).toEqual([]);
          },
        ),
      );
      expect(parseAnnotations(null)).toEqual([]);
      expect(parseAnnotations(undefined)).toEqual([]);
      expect(parseAnnotations("")).toEqual([]);
    });

    it("round-trips any well-formed annotation embedded in surrounding prose", () => {
      fc.assert(
        fc.property(proseArb, annotationArb, proseArb, (before, ann, after) => {
          // A `(` right after a bare name would be read as its argument list, so prose after the
          // annotation is separated by a newline like Prisma's `///` line joins.
          const parsed = parseAnnotations(`${before} ${ann.text}\n${after}`);
          expect(parsed).toEqual([{ name: ann.name, args: ann.args }]);
        }),
      );
    });

    it("parses several annotations in document order, one entry each", () => {
      fc.assert(
        fc.property(fc.array(annotationArb, { minLength: 1, maxLength: 5 }), proseArb, (anns, prose) => {
          const doc = anns.map((a) => a.text).join(`\n${prose}\n`);
          expect(parseAnnotations(doc)).toEqual(anns.map((a) => ({ name: a.name, args: a.args })));
        }),
      );
    });

    it("parenthesized prose on the next line is never mistaken for an argument list", () => {
      fc.assert(
        fc.property(annotationNameArb, proseArb, (name, prose) => {
          expect(parseAnnotations(`@timescale.${name}\n(${prose})`)).toEqual([{ name, args: {} }]);
          expect(parseAnnotations(`@timescale.${name} (${prose})`)).toEqual([{ name, args: {} }]);
        }),
      );
    });

    it("is insensitive to whitespace around keys, colons and commas", () => {
      const ws = fc.array(fc.constantFrom(" ", "\n", "\t"), { maxLength: 3 }).map((cs) => cs.join(""));
      fc.assert(
        fc.property(annotationNameArb, safeIdentArb, quotedValueArb, ws, ws, ws, ws, (name, key, value, a, b, c, d) => {
          const doc = `@timescale.${name}(${a}${key}${b}:${c}"${escape(value)}"${d})`;
          expect(parseAnnotations(doc)).toEqual([{ name, args: { [key]: value } }]);
        }),
      );
    });
  });

  describe("objectsMigrationName / maxObjectsSequence", () => {
    const sequenceArb = fc.integer({ min: 1, max: 99_999 });
    const namePattern = new RegExp(`^${OBJECTS_MIGRATION_PREFIX}_v\\d{4,}$`);

    it("every generated folder name has the versioned shape and parses back to its sequence", () => {
      fc.assert(
        fc.property(sequenceArb, (n) => {
          const name = objectsMigrationName(n);
          expect(name).toMatch(namePattern);
          expect(maxObjectsSequence([name])).toBe(n);
        }),
      );
    });

    it("sorts by code point in the same order as by sequence number, up to four digits", () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 9_999 }), fc.integer({ min: 1, max: 9_999 }), (a, b) => {
          const [na, nb] = [objectsMigrationName(a), objectsMigrationName(b)];
          expect(na < nb).toBe(a < b);
          expect(na === nb).toBe(a === b);
        }),
      );
    });

    it("maxObjectsSequence is the maximum, regardless of order and of unrelated folders", () => {
      const noiseArb = fc.string().filter((s) => !s.startsWith(OBJECTS_MIGRATION_PREFIX));
      // The order comes from fast-check too, so a failure replays from the reported seed and shrinks.
      const shuffledNamesArb = fc
        .tuple(fc.array(sequenceArb, { minLength: 1 }), fc.array(noiseArb))
        .chain(([seqs, noise]) => {
          const names = [...seqs.map(objectsMigrationName), ...noise, "00000000000000_timescaledb_extension"];
          return fc
            .shuffledSubarray(names, { minLength: names.length, maxLength: names.length })
            .map((shuffled) => ({ seqs, shuffled }));
        });
      fc.assert(
        fc.property(shuffledNamesArb, ({ seqs, shuffled }) => {
          expect(maxObjectsSequence(shuffled)).toBe(Math.max(...seqs));
        }),
      );
    });

    it("ignores the legacy fixed-name folder and near misses", () => {
      fc.assert(
        fc.property(fc.array(fc.string()), (noise) => {
          const names = [
            ...noise.filter((s) => !s.startsWith(OBJECTS_MIGRATION_PREFIX)),
            OBJECTS_MIGRATION_PREFIX,
            `${OBJECTS_MIGRATION_PREFIX}_v1`,
            `${OBJECTS_MIGRATION_PREFIX}_v001`,
            `${OBJECTS_MIGRATION_PREFIX}_v0001x`,
          ];
          expect(maxObjectsSequence(names)).toBe(0);
        }),
      );
    });
  });

  describe("parseGeneratorState", () => {
    const validStateArb: fc.Arbitrary<GeneratorState> = fc.integer({ min: 1, max: 1_000_000 }).map((sequence) => ({
      version: 1,
      sequence,
      state: { hypertables: [], continuousAggregates: [] },
    }));

    it("never throws, whatever the file contains", () => {
      fc.assert(
        fc.property(fc.oneof(fc.string(), fc.json()), (raw) => {
          expect(() => parseGeneratorState(raw)).not.toThrow();
        }),
      );
      expect(parseGeneratorState(undefined)).toBeUndefined();
    });

    it("round-trips a well-formed state through JSON", () => {
      fc.assert(
        fc.property(validStateArb, (state) => {
          expect(parseGeneratorState(JSON.stringify(state))).toEqual(state);
        }),
      );
    });

    it("rejects any sequence below 1 or not an integer, and any version that is not 1 or a newer integer", () => {
      fc.assert(
        fc.property(
          validStateArb,
          fc.oneof(fc.integer({ max: 0 }), fc.double({ noInteger: true, noNaN: true }), fc.string()),
          fc.oneof(fc.integer({ max: 0 }), fc.double({ noInteger: true, noNaN: true }), fc.string(), fc.constant(null)),
          (state, badSequence, badVersion) => {
            expect(parseGeneratorState(JSON.stringify({ ...state, sequence: badSequence }))).toBeUndefined();
            expect(parseGeneratorState(JSON.stringify({ ...state, version: badVersion }))).toBeUndefined();
          },
        ),
      );
    });

    // Issue #160: an integer version above 1 is a newer release's file, never "unreadable",
    // whatever the rest of the file looks like.
    it("throws NewerStateFileError for every integer version above 1", () => {
      fc.assert(
        fc.property(validStateArb, fc.integer({ min: 2 }), fc.boolean(), (state, newer, wholeShape) => {
          const file = wholeShape ? { ...state, version: newer } : { version: newer };
          expect(() => parseGeneratorState(JSON.stringify(file))).toThrow(NewerStateFileError);
        }),
      );
    });

    it("rejects a state whose arrays are missing or not arrays", () => {
      fc.assert(
        fc.property(validStateArb, fc.oneof(fc.string(), fc.constant(null), fc.integer(), fc.constant({})), (state, bad) => {
          expect(parseGeneratorState(JSON.stringify({ ...state, state: { ...state.state, hypertables: bad } }))).toBeUndefined();
          expect(
            parseGeneratorState(JSON.stringify({ ...state, state: { ...state.state, continuousAggregates: bad } })),
          ).toBeUndefined();
        }),
      );
    });
  });
});
