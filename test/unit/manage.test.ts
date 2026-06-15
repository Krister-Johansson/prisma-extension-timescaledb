import { describe, expect, it } from "vitest";
import { makeManage, type RawClient } from "../../src/client/manage.js";

function fakeClient() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client: RawClient = {
    async $executeRawUnsafe(sql, ...params) {
      calls.push({ sql, params });
      return 0;
    },
  };
  return { client, calls };
}

describe("makeManage.refreshContinuousAggregate", () => {
  it("full refresh uses literal NULL bounds and binds no params", async () => {
    const { client, calls } = fakeClient();
    await makeManage(client).refreshContinuousAggregate("SensorHourly");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toBe(`CALL refresh_continuous_aggregate('"SensorHourly"', NULL, NULL)`);
    expect(calls[0]!.params).toEqual([]);
  });

  it("windowed refresh binds provided dates as params", async () => {
    const { client, calls } = fakeClient();
    const start = new Date("2026-06-15T00:00:00Z");
    const end = new Date("2026-06-16T00:00:00Z");
    await makeManage(client).refreshContinuousAggregate("SensorHourly", { start, end });
    expect(calls[0]!.sql).toBe(`CALL refresh_continuous_aggregate('"SensorHourly"', $1, $2)`);
    expect(calls[0]!.params).toEqual([start, end]);
  });

  it("mixes a literal NULL with a bound param when only one bound is given", async () => {
    const { client, calls } = fakeClient();
    const start = new Date("2026-06-15T00:00:00Z");
    await makeManage(client).refreshContinuousAggregate("SensorHourly", { start });
    expect(calls[0]!.sql).toBe(`CALL refresh_continuous_aggregate('"SensorHourly"', $1, NULL)`);
    expect(calls[0]!.params).toEqual([start]);
  });

  it("rejects an unsafe continuous-aggregate name", async () => {
    const { client } = fakeClient();
    await expect(makeManage(client).refreshContinuousAggregate("bad name")).rejects.toThrow(/Invalid/);
  });
});
