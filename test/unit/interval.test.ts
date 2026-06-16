import { describe, expect, it } from "vitest";
import { assertInterval, isInterval } from "../../src/core/interval.js";

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

  it("rejects malformed intervals and non-input units (quarter, millennium)", () => {
    // `quarter` / `millennium` are EXTRACT fields, not interval input units in PostgreSQL.
    for (const v of ["hour", "1hour", "1 fortnight", "1 quarter", "1 millennium", "1  hour", " 1 hour", "1 hour ", "-1 hours", ""]) {
      expect(isInterval(v)).toBe(false);
      expect(() => assertInterval(v)).toThrow(/Invalid interval/);
    }
  });
});
