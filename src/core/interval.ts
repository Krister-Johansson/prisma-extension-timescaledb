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
 *
 * The type is a typo guard, not the authority. `${number}` is wider than the runtime grammar:
 * `"-1 hour"`, `"0 days"`, `".5 hours"` and `"1e3 hours"` compile and are rejected by
 * `isInterval` / `assertInterval`. It stays this wide on purpose, so an interval built from a
 * number (`\`${n} hours\``) keeps type-checking.
 */
export type Interval = `${number} ${Unit}`;

// `<digits>[.<digits>] <unit>` — exactly one space, a non-negative amount, a known unit
// (mirrors the `${number} ${Unit}` template type).
const INTERVAL_RE = new RegExp(`^\\d+(?:\\.\\d+)? (?:${UNITS.join("|")})$`);

/** Microseconds per sub-day unit. Postgres keeps these in the interval's int64 time field. */
const MICROS: Partial<Record<Unit, bigint>> = {
  microsecond: 1n,
  microseconds: 1n,
  millisecond: 1_000n,
  milliseconds: 1_000n,
  second: 1_000_000n,
  seconds: 1_000_000n,
  minute: 60_000_000n,
  minutes: 60_000_000n,
  hour: 3_600_000_000n,
  hours: 3_600_000_000n,
};

/** Days per day-based unit. Postgres keeps whole days in a separate int32 field. */
const DAYS: Partial<Record<Unit, bigint>> = { day: 1n, days: 1n, week: 7n, weeks: 7n };

/** Months per calendar unit, the interval's int32 month field. */
const MONTHS: Partial<Record<Unit, bigint>> = {
  month: 1n,
  months: 1n,
  year: 12n,
  years: 12n,
  decade: 120n,
  decades: 120n,
  century: 1200n,
  centuries: 1200n,
};

const MICROS_PER_DAY = 86_400_000_000n;

// The three fields of a Postgres interval. Anything past a limit passes the shape check and
// fails at migrate deploy with "interval field value out of range" (probed on PG 17).
const MAX_MICROS = 9_223_372_036_854_775_807n;
const MAX_DAYS = 2_147_483_647n;
const MAX_MONTHS = 2_147_483_647n;

/** The amount as an exact rational `whole / scale`, so decimal amounts compare without float
 * error ("1.1 hours" is exactly 3 960 000 000 microseconds, not 3 960 000 000.0000005). */
function parts(value: string): { unit: Unit; whole: bigint; scale: bigint } {
  const [amount, unit] = value.split(" ") as [string, Unit];
  const [int, frac = ""] = amount.split(".") as [string, string?];
  return { unit, whole: BigInt(int + frac), scale: 10n ** BigInt(frac.length) };
}

/** Round `numerator / denominator` to the nearest integer, halves up. */
function divRound(numerator: bigint, denominator: bigint): bigint {
  return (2n * numerator + denominator) / (2n * denominator);
}

/** Return true if `value` is a well-formed interval literal with a positive amount that fits
 * the interval type. */
export function isInterval(value: string): value is Interval {
  // Shape must match AND the amount must be positive: "0 days" / "0.0 seconds" are well-formed but
  // meaningless as a chunk size / policy threshold / bucket width (TimescaleDB rejects them anyway).
  if (!INTERVAL_RE.test(value)) return false;
  const { unit, whole, scale } = parts(value);
  if (whole === 0n) return false;
  const micros = MICROS[unit];
  if (micros !== undefined) return whole * micros <= MAX_MICROS * scale;
  const days = DAYS[unit];
  if (days !== undefined) return whole * days <= MAX_DAYS * scale;
  return whole * (MONTHS[unit] ?? 0n) <= MAX_MONTHS * scale;
}

/**
 * The width of a fixed-width interval in microseconds, rounded the way Postgres stores it, or
 * undefined for a calendar unit (month and up), whose width depends on the date it is applied
 * to. A bigint, so two-bucket window checks are exact for decimal amounts.
 */
export function intervalToMicroseconds(value: Interval): bigint | undefined {
  const { unit, whole, scale } = parts(value);
  const micros = MICROS[unit];
  if (micros !== undefined) return divRound(whole * micros, scale);
  const days = DAYS[unit];
  if (days !== undefined) return divRound(whole * days * MICROS_PER_DAY, scale);
  return undefined;
}

/**
 * True unless the interval is a fractional number of MONTHS. Postgres turns "1.5 months" into
 * 1 month 15 days, which time_bucket rejects ("month intervals cannot have day or time
 * component"), but rounds a fractional year, decade or century to whole months ("1.1 years"
 * is 1 year 1 mon), which time_bucket takes. Fixed-width units are always fine.
 */
export function isWholeMonths(value: Interval): boolean {
  const { unit, whole, scale } = parts(value);
  return !(unit === "month" || unit === "months") || whole % scale === 0n;
}

/** Assert `value` is a well-formed interval literal, narrowing its type. */
export function assertInterval(value: string): asserts value is Interval {
  if (!isInterval(value)) {
    throw new Error(
      `Invalid interval ${JSON.stringify(value)}: expected "<amount> <unit>" with a positive amount, where unit is one of ${UNITS.join(", ")} (e.g. "1 hour", "7 days").`,
    );
  }
}
