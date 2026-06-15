import { describe, expect, it } from "vitest";
import { assertSafeIdent, quoteIdent, quoteLiteral, relationLiteral } from "../../src/core/sql.js";

describe("sql helpers", () => {
  it("quotes identifiers and preserves case", () => {
    expect(quoteIdent("SensorReading")).toBe('"SensorReading"');
    expect(quoteIdent("deviceId")).toBe('"deviceId"');
  });

  it("escapes embedded double quotes in identifiers", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it("quotes string literals and escapes single quotes", () => {
    expect(quoteLiteral("1 hour")).toBe("'1 hour'");
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("renders a relation as a quoted string literal (no casts)", () => {
    expect(relationLiteral("SensorReading")).toBe(`'"SensorReading"'`);
  });

  it("rejects unsafe identifiers", () => {
    for (const bad of ["", "1abc", "a-b", "drop table", 'a"b']) {
      expect(() => assertSafeIdent(bad)).toThrow(/Invalid identifier/);
    }
    expect(() => assertSafeIdent("SensorReading")).not.toThrow();
    expect(() => assertSafeIdent("_x9")).not.toThrow();
  });
});
