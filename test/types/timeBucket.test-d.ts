// Type-level tests for model.timeBucket (BUILD_PLAN M4 gate). Checked by
// `npm run test:types` (tsc -p tsconfig.types.json). No runtime assertions here:
// success == it type-checks, and each `@ts-expect-error` must actually error.
import type { TimeBucketArgs, TimeBucketRow } from "../../src/client/timeBucket.js";

// Exact type-equality assertion (dependency-free).
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// A representative model scalar row + where input (what Prisma.Result / Prisma.Args yield).
interface Row {
  time: Date;
  deviceId: number;
  temperature: number;
  label: string;
}
interface Where {
  deviceId?: number;
  label?: string;
}

// Mirrors the real method's generic signature, pinned to Row/Where.
declare function timeBucket<const A extends TimeBucketArgs<Row, Where>>(args: A): Array<TimeBucketRow<Row, A>>;

const start = new Date();
const end = new Date();

// --- positive: result row is inferred from groupBy + aggregate ---
const rows = timeBucket({
  bucket: "1 hour",
  range: { start, end },
  where: { deviceId: 1 },
  groupBy: ["deviceId"],
  aggregate: {
    avgTemp: { avg: "temperature" },
    maxTemp: { max: "temperature" },
    n: { count: "label" },
  },
});
type RowResult = (typeof rows)[number];
type _inferred = Expect<
  Equal<RowResult, { bucket: Date; deviceId: number; avgTemp: number; maxTemp: number; n: number }>
>;

// no groupBy -> just bucket + aggregates
const rows2 = timeBucket({
  bucket: "30 minutes",
  range: { start, end },
  aggregate: { total: { sum: "temperature" } },
});
type _inferred2 = Expect<Equal<(typeof rows2)[number], { bucket: Date; total: number }>>;

// --- `as` selector: each aggregate's result type follows its exact-output kind ---
const exact = timeBucket({
  bucket: "1 hour",
  range: { start, end },
  groupBy: ["deviceId"],
  aggregate: {
    bytes: { sum: "temperature", as: "bigint" }, // -> bigint
    rows: { count: "label", as: "bigint" }, // -> bigint
    avgStr: { avg: "temperature", as: "string" }, // -> string
    sumStr: { sum: "temperature", as: "string" }, // -> string
    plain: { sum: "temperature" }, // -> number (default)
    explicit: { avg: "temperature", as: "number" }, // -> number
  },
});
type _exact = Expect<
  Equal<
    (typeof exact)[number],
    {
      bucket: Date;
      deviceId: number;
      bytes: bigint;
      rows: bigint;
      avgStr: string;
      sumStr: string;
      plain: number;
      explicit: number;
    }
  >
>;

// --- gapfill: every aggregate becomes nullable; a `fill`ed aggregate is number|null ---
const gf = timeBucket({
  bucket: "1 hour",
  range: { start, end },
  groupBy: ["deviceId"],
  gapfill: true,
  aggregate: {
    carried: { avg: "temperature", fill: "locf" },
    line: { avg: "temperature", fill: "interpolate" },
    raw: { avg: "temperature" },
    total: { sum: "temperature", as: "bigint" }, // `as` still applies; nullable under gapfill
  },
});
type _gf = Expect<
  Equal<
    (typeof gf)[number],
    { bucket: Date; deviceId: number; carried: number | null; line: number | null; raw: number | null; total: bigint | null }
  >
>;

// without gapfill, aggregates stay non-null (unchanged)
const nogf = timeBucket({ bucket: "1 hour", range: { start, end }, aggregate: { raw: { avg: "temperature" } } });
type _nogf = Expect<Equal<(typeof nogf)[number], { bucket: Date; raw: number }>>;

// --- first / last: result type is the value column's type (default ordered by time) ---
const fl = timeBucket({
  bucket: "1 hour",
  range: { start, end },
  aggregate: {
    firstTemp: { first: "temperature" }, // number
    lastLabel: { last: "label" }, // string
    firstTime: { first: "time" }, // Date
    lastTempByDevice: { last: "temperature", by: "deviceId" }, // number, ordered by another column
  },
});
type _fl = Expect<
  Equal<
    (typeof fl)[number],
    { bucket: Date; firstTemp: number; lastLabel: string; firstTime: Date; lastTempByDevice: number }
  >
>;

// first / last become nullable under gapfill, keeping their column type
const flgf = timeBucket({ bucket: "1 hour", range: { start, end }, gapfill: true, aggregate: { lastLabel: { last: "label" } } });
type _flgf = Expect<Equal<(typeof flgf)[number], { bucket: Date; lastLabel: string | null }>>;

// --- negatives: each must fail to compile ---

// first on a column that doesn't exist
timeBucket({
  bucket: "1 hour",
  range: { start, end },
  // @ts-expect-error - "nope" is not a column of Row
  aggregate: { x: { first: "nope" } },
});

// an invalid fill mode
timeBucket({
  bucket: "1 hour",
  range: { start, end },
  gapfill: true,
  // @ts-expect-error - "ffill" is not a valid fill mode
  aggregate: { x: { avg: "temperature", fill: "ffill" } },
});

// avg cannot be "bigint" (it is fractional)
timeBucket({
  bucket: "1 hour",
  range: { start, end },
  // @ts-expect-error - avg does not accept as: "bigint"
  aggregate: { x: { avg: "temperature", as: "bigint" } },
});

// count cannot be "string" (it is an integer count)
timeBucket({
  bucket: "1 hour",
  range: { start, end },
  // @ts-expect-error - count does not accept as: "string"
  aggregate: { x: { count: "label", as: "string" } },
});

// an unknown `as` value
timeBucket({
  bucket: "1 hour",
  range: { start, end },
  // @ts-expect-error - "float" is not a valid `as`
  aggregate: { x: { sum: "temperature", as: "float" } },
});

// avg on a column that doesn't exist
timeBucket({
  bucket: "1 hour",
  range: { start, end },
  // @ts-expect-error - "nope" is not a column of Row
  aggregate: { x: { avg: "nope" } },
});

// avg on a non-numeric column (label is string)
timeBucket({
  bucket: "1 hour",
  range: { start, end },
  // @ts-expect-error - "label" is not a numeric column
  aggregate: { x: { avg: "label" } },
});

// missing required range
// @ts-expect-error - `range` is required
timeBucket({ bucket: "1 hour", aggregate: { x: { avg: "temperature" } } });

// groupBy on a non-existent column
timeBucket({
  bucket: "1 hour",
  range: { start, end },
  // @ts-expect-error - "nope" is not a column of Row
  groupBy: ["nope"],
  aggregate: { x: { avg: "temperature" } },
});

// invalid interval literal
timeBucket({
  // @ts-expect-error - "1 fortnight" is not a valid Interval
  bucket: "1 fortnight",
  range: { start, end },
  aggregate: { x: { avg: "temperature" } },
});

export {};
