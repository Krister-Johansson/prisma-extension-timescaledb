// Interval type + runtime validator (SPEC §4.3). The branded template type catches typos at
// compile time; the runtime validator guards the string we interpolate into SQL (intervals
// are interpolated, so validating their shape also closes the injection vector there).

// The full set of PostgreSQL interval *input* units (datatype-datetime.html §8.5.4),
// singular + plural. Note: `quarter` is NOT here — it is an EXTRACT field only, not a valid
// interval input unit (`INTERVAL '1 quarter'` errors). Combined forms ("1 year 2 months"),
// ISO 8601, and bare abbreviations are intentionally unsupported by this single-unit type.
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
] as const;

type Unit = (typeof UNITS)[number];

/**
 * A Postgres/TimescaleDB interval literal, branded at the type level to catch typos at
 * compile time, e.g. `"1 hour"`, `"7 days"`, `"30 minutes"`, `"2 years"`.
 */
export type Interval = `${number} ${Unit}`;

// `<digits>[.<digits>] <unit>` — exactly one space, a non-negative amount, a known unit
// (mirrors the `${number} ${Unit}` template type).
const INTERVAL_RE = new RegExp(`^\\d+(?:\\.\\d+)? (?:${UNITS.join("|")})$`);

/** Return true if `value` is a well-formed interval literal with a positive amount. */
export function isInterval(value: string): value is Interval {
  // Shape must match AND the amount must be positive: "0 days" / "0.0 seconds" are well-formed but
  // meaningless as a chunk size / policy threshold / bucket width (TimescaleDB rejects them anyway).
  return INTERVAL_RE.test(value) && Number.parseFloat(value) > 0;
}

/** Assert `value` is a well-formed interval literal, narrowing its type. */
export function assertInterval(value: string): asserts value is Interval {
  if (!isInterval(value)) {
    throw new Error(
      `Invalid interval ${JSON.stringify(value)}: expected "<amount> <unit>" with a positive amount, where unit is one of ${UNITS.join(", ")} (e.g. "1 hour", "7 days").`,
    );
  }
}
