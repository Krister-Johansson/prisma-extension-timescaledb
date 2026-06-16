import { describe, expect, it } from "vitest";
import { assertInterval, isInterval } from "../../src/core/interval.js";

describe("interval", () => {
  it("accepts well-formed intervals", () => {
    for (const v of ["1 hour", "7 days", "30 minutes", "1 second", "12 months", "2 weeks", "1.5 days", "1 year", "2 years"]) {
      expect(isInterval(v)).toBe(true);
      expect(() => assertInterval(v)).not.toThrow();
    }
  });

  it("rejects malformed intervals", () => {
    for (const v of ["hour", "1hour", "1 fortnight", "1  hour", " 1 hour", "1 hour ", "-1 hours", ""]) {
      expect(isInterval(v)).toBe(false);
      expect(() => assertInterval(v)).toThrow(/Invalid interval/);
    }
  });
});
