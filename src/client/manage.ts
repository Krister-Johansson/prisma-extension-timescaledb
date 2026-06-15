// The $timescale management namespace (SPEC §4.3).
import { assertSafeIdent, quoteIdent } from "../core/sql.js";

/** Minimal raw-capable client surface we rely on (PrismaClient provides these). */
export interface RawClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Range for a continuous-aggregate refresh; null bounds mean "open" (full refresh). */
export interface RefreshRange {
  start?: Date | null;
  end?: Date | null;
}

export interface TimescaleManage {
  /**
   * Refresh a continuous aggregate over an optional time window (SPEC §4.3).
   * The name is passed as a quoted identifier so mixed-case caggs resolve correctly
   * (an unquoted name case-folds and fails — surfaced in the spike).
   */
  refreshContinuousAggregate(name: string, range?: RefreshRange): Promise<void>;
}

export function makeManage(client: RawClient): TimescaleManage {
  return {
    async refreshContinuousAggregate(name, range) {
      assertSafeIdent(name, "continuous aggregate name");
      // Open bounds (full refresh) must be a literal NULL, not a bound param: Postgres
      // can't infer the type of a NULL parameter for the function's "any" window args.
      const params: unknown[] = [];
      const bound = (value: Date | null | undefined): string => {
        if (value == null) return "NULL";
        params.push(value);
        return `$${params.length}`;
      };
      const sql = `CALL refresh_continuous_aggregate('${quoteIdent(name)}', ${bound(range?.start)}, ${bound(range?.end)})`;
      await client.$executeRawUnsafe(sql, ...params);
    },
  };
}
