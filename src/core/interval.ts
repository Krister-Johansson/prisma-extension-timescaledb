// Interval type + runtime validator (SPEC §4.3). The branded template type catches typos at
// compile time; the runtime validator guards the string we interpolate into SQL (intervals
// are interpolated, so validating their shape also closes the injection vector there).

const UNITS = [
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
] as const;

type Unit = (typeof UNITS)[number];

/**
 * A Postgres/TimescaleDB interval literal, branded at the type level to catch typos at
 * compile time, e.g. `"1 hour"`, `"7 days"`, `"30 minutes"`.
 */
export type Interval = `${number} ${Unit}`;

// `<digits>[.<digits>] <unit>` — exactly one space, a non-negative amount, a known unit
// (mirrors the `${number} ${Unit}` template type).
const INTERVAL_RE = new RegExp(`^\\d+(?:\\.\\d+)? (?:${UNITS.join("|")})$`);

/** Return true if `value` is a well-formed interval literal. */
export function isInterval(value: string): value is Interval {
  return INTERVAL_RE.test(value);
}

/** Assert `value` is a well-formed interval literal, narrowing its type. */
export function assertInterval(value: string): asserts value is Interval {
  if (!isInterval(value)) {
    throw new Error(
      `Invalid interval ${JSON.stringify(value)}: expected "<amount> <unit>" where unit is one of ${UNITS.join(", ")} (e.g. "1 hour", "7 days").`,
    );
  }
}
