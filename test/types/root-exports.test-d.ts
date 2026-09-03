// Type-level test: the timeBucket types are reachable from the PACKAGE ROOT, the only
// published entry point ("." in package.json exports). Consumers type wrappers around
// model.timeBucket(...) with these; before this test they existed only in the client
// barrel, which is not published, so no consumer could name them.
import type {
  TimeBucketArgs,
  TimeBucketRow,
  AggregateInput,
  AggregateOp,
  ScalarRow,
  WhereInput,
  TimescaleManage,
  JobStats,
} from "../../src/index.js";

interface Row {
  time: Date;
  deviceId: number;
  temperature: number;
}

// A consumer-style wrapper signature: args in, typed rows out.
declare function myWrapper<const A extends TimeBucketArgs<Row, { deviceId?: number }>>(
  args: A,
): Promise<Array<TimeBucketRow<Row, A>>>;

const agg: AggregateInput<Row> = { avgTemp: { avg: "temperature" } };
const op: AggregateOp<Row> = { max: "temperature" };

declare const rows: Awaited<ReturnType<typeof myWrapper<{ bucket: "1 hour"; range: { start: Date; end: Date }; aggregate: { avgTemp: { avg: "temperature" } } }>>>;
const _n: number = rows[0]!.avgTemp;

// The manage types stay importable alongside them.
declare const manage: TimescaleManage;
declare const stats: JobStats[];

// Prisma-coupled helpers resolve too (structurally unknown here, but must be nameable).
type _S = ScalarRow<unknown>;
type _W = WhereInput<unknown>;

// Silence unused-variable checks: naming the values is the whole test.
export { agg, op, _n, manage, stats };
export type { _S, _W };
