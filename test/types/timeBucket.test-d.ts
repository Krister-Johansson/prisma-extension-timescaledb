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

// --- negatives: each must fail to compile ---

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
