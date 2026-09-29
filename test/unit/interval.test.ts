import { describe, expect, it } from "vitest";
import { assertInterval, intervalToMicroseconds, isInterval, isWholeMonths } from "../../src/core/interval.js";

describe("interval", () => {
  it("accepts well-formed intervals across the full PostgreSQL unit set", () => {
    for (const v of [
      "1 hour",
      "7 days",
      "30 minutes",
      "1 second",
      "12 months",
      "2 weeks",
      "1.5 days",
      "1 year",
      "2 years",
      "500 microseconds",
      "250 milliseconds",
      "3 decades",
      "1 century",
      "2 centuries",
    ]) {
      expect(isInterval(v)).toBe(true);
      expect(() => assertInterval(v)).not.toThrow();
    }
  });

  it("rejects malformed intervals, non-input units (quarter, millennium), and non-positive amounts", () => {
    // `quarter` / `millennium` are EXTRACT fields, not interval input units in PostgreSQL.
    // "0 …" is well-formed shape-wise, but a zero amount is meaningless for a chunk size / policy
    // threshold / bucket width (negatives are already rejected by the grammar — no leading `-`).
    for (const v of ["hour", "1hour", "1 fortnight", "1 quarter", "1 millennium", "1  hour", " 1 hour", "1 hour ", "-1 hours", "0 days", "0.0 seconds", "00 hours", ""]) {
      expect(isInterval(v)).toBe(false);
      expect(() => assertInterval(v)).toThrow(/Invalid interval/);
    }
  });
});

// Issue #162: amounts past what the interval type can hold passed the shape check and failed at
// migrate deploy with "interval field value out of range".
describe("interval limits and width helpers (issue #162)", () => {
  it("caps fixed-width amounts at int64 microseconds and calendar amounts at int32 months", () => {
    expect(isInterval("99999999999999999999 hours")).toBe(false);
    expect(isInterval("9223372036854 seconds")).toBe(true); // just under the limit
    expect(isInterval("9223372036855 seconds")).toBe(false); // just over
    expect(isInterval("2147483647 months")).toBe(true);
    expect(isInterval("2147483648 months")).toBe(false);
    expect(isInterval("1789569 centuries")).toBe(true); // 2147482800 months
    expect(isInterval("1789570 centuries")).toBe(false);
    expect(() => assertInterval("99999999999999999999 hours")).toThrow(/Invalid interval/);
  });

  it("intervalToMicroseconds knows the fixed units and declines calendar ones", () => {
    expect(intervalToMicroseconds("1 hour")).toBe(3_600_000_000);
    expect(intervalToMicroseconds("1.5 days")).toBe(129_600_000_000);
    expect(intervalToMicroseconds("2 weeks")).toBe(1_209_600_000_000);
    expect(intervalToMicroseconds("250 milliseconds")).toBe(250_000);
    expect(intervalToMicroseconds("1 month")).toBeUndefined();
    expect(intervalToMicroseconds("1 year")).toBeUndefined();
  });

  it("isWholeMonths is true for fixed units and for calendar amounts that are whole months", () => {
    expect(isWholeMonths("1.5 hours")).toBe(true);
    expect(isWholeMonths("1 month")).toBe(true);
    expect(isWholeMonths("1.5 months")).toBe(false);
    expect(isWholeMonths("1.5 years")).toBe(true); // 18 months
    expect(isWholeMonths("1.1 years")).toBe(false); // 13.2 months
    expect(isWholeMonths("0.5 decades")).toBe(true); // 60 months
    expect(isWholeMonths("0.25 centuries")).toBe(true); // 300 months
  });
});
