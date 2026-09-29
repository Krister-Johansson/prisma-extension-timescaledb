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
  // Every limit below was probed on PG 17: the value on the left of each pair is accepted and
  // the one on the right fails with "interval field value out of range".
  it("caps each amount at the Postgres field that holds it, exactly at the boundary", () => {
    expect(isInterval("99999999999999999999 hours")).toBe(false);
    expect(isInterval("9223372036854775807 microseconds")).toBe(true); // int64 time field
    expect(isInterval("9223372036854775808 microseconds")).toBe(false); // one more than int64
    expect(isInterval("9223372036854 seconds")).toBe(true);
    expect(isInterval("9223372036855 seconds")).toBe(false);
    expect(isInterval("2147483647 days")).toBe(true); // int32 day field, separate from time
    expect(isInterval("2147483648 days")).toBe(false);
    expect(isInterval("306783378 weeks")).toBe(true); // 2147483646 days
    expect(isInterval("306783379 weeks")).toBe(false);
    expect(isInterval("2147483647 months")).toBe(true); // int32 month field
    expect(isInterval("2147483648 months")).toBe(false);
    expect(isInterval("1789569 centuries")).toBe(true); // 2147482800 months
    expect(isInterval("1789570 centuries")).toBe(false);
    expect(() => assertInterval("99999999999999999999 hours")).toThrow(/Invalid interval/);
  });

  it("intervalToMicroseconds is exact for decimal amounts and declines calendar units", () => {
    expect(intervalToMicroseconds("1 hour")).toBe(3_600_000_000n);
    expect(intervalToMicroseconds("1.1 hours")).toBe(3_960_000_000n); // not 3960000000.0000005
    expect(intervalToMicroseconds("1.5 days")).toBe(129_600_000_000n);
    expect(intervalToMicroseconds("2 weeks")).toBe(1_209_600_000_000n);
    expect(intervalToMicroseconds("250 milliseconds")).toBe(250_000n);
    expect(intervalToMicroseconds("0.0000015 seconds")).toBe(2n); // rounded, halves up
    expect(intervalToMicroseconds("1 month")).toBeUndefined();
    expect(intervalToMicroseconds("1 year")).toBeUndefined();
  });

  // Probed on PG 17: '1.1 years' is 1 year 1 mon and '1.15 decades' is 11 years 6 mons, both
  // fine for time_bucket; '1.5 months' is 1 mon 15 days, which it rejects.
  it("isWholeMonths is false only for a fractional number of months", () => {
    expect(isWholeMonths("1.5 hours")).toBe(true);
    expect(isWholeMonths("1 month")).toBe(true);
    expect(isWholeMonths("1.0 months")).toBe(true);
    expect(isWholeMonths("1.5 months")).toBe(false);
    expect(isWholeMonths("1.5 years")).toBe(true);
    expect(isWholeMonths("1.1 years")).toBe(true);
    expect(isWholeMonths("4.1 decades")).toBe(true); // 4.1 * 120 is 491.99999999999994 in floats
    expect(isWholeMonths("0.25 centuries")).toBe(true);
  });
});
