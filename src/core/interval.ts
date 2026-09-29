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

/** Microseconds per fixed-width unit. Months and up are calendar units with no fixed width;
 * Postgres stores them as a separate month count, so they are absent here on purpose. */
const MICROS: Partial<Record<Unit, number>> = {
  microsecond: 1,
  microseconds: 1,
  millisecond: 1_000,
  milliseconds: 1_000,
  second: 1_000_000,
  seconds: 1_000_000,
  minute: 60_000_000,
  minutes: 60_000_000,
  hour: 3_600_000_000,
  hours: 3_600_000_000,
  day: 86_400_000_000,
  days: 86_400_000_000,
  week: 604_800_000_000,
  weeks: 604_800_000_000,
};

/** Months per calendar unit. */
const MONTHS: Partial<Record<Unit, number>> = {
  month: 1,
  months: 1,
  year: 12,
  years: 12,
  decade: 120,
  decades: 120,
  century: 1200,
  centuries: 1200,
};

// Postgres stores an interval as int64 microseconds plus int32 months. Anything past either
// limit passes the shape check and fails at migrate with "interval field value out of range".
const MAX_MICROS = 9_223_372_036_854_775_807;
const MAX_MONTHS = 2_147_483_647;

function parts(value: string): { amount: number; unit: Unit } {
  const [amount, unit] = value.split(" ") as [string, Unit];
  return { amount: Number.parseFloat(amount), unit };
}

/** Return true if `value` is a well-formed interval literal with a positive amount that fits
 * the interval type. */
export function isInterval(value: string): value is Interval {
  // Shape must match AND the amount must be positive: "0 days" / "0.0 seconds" are well-formed but
  // meaningless as a chunk size / policy threshold / bucket width (TimescaleDB rejects them anyway).
  if (!INTERVAL_RE.test(value)) return false;
  const { amount, unit } = parts(value);
  if (!(amount > 0)) return false;
  const micros = MICROS[unit];
  if (micros !== undefined) return amount * micros <= MAX_MICROS;
  return amount * (MONTHS[unit] ?? 0) <= MAX_MONTHS;
}

/**
 * The width of a fixed-width interval in microseconds, or undefined for a calendar unit
 * (month and up), whose width depends on the date it is applied to.
 */
export function intervalToMicroseconds(value: Interval): number | undefined {
  const { amount, unit } = parts(value);
  const micros = MICROS[unit];
  return micros === undefined ? undefined : amount * micros;
}

/**
 * True when a calendar interval is a whole number of months, or the interval is fixed-width.
 * Postgres turns a fractional month into days ("1.5 months" is 1 month 15 days), and
 * time_bucket rejects a month interval with a day or time component.
 */
export function isWholeMonths(value: Interval): boolean {
  const { amount, unit } = parts(value);
  const perUnit = MONTHS[unit];
  return perUnit === undefined || Number.isInteger(amount * perUnit);
}

/** Assert `value` is a well-formed interval literal, narrowing its type. */
export function assertInterval(value: string): asserts value is Interval {
  if (!isInterval(value)) {
    throw new Error(
      `Invalid interval ${JSON.stringify(value)}: expected "<amount> <unit>" with a positive amount, where unit is one of ${UNITS.join(", ")} (e.g. "1 hour", "7 days").`,
    );
  }
}
