import { describe, expect, it } from "vitest";
import { timescaledb } from "../../src/client/index.js";
import * as pkg from "../../src/index.js";
import * as core from "../../src/core/index.js";

describe("public entry points", () => {
  it("re-exports the runtime + core surface", () => {
    expect(typeof pkg.timescaledb).toBe("function");
    expect(typeof pkg.createHypertableSql).toBe("function");
    expect(typeof core.createContinuousAggregateSql).toBe("function");
    expect(typeof core.assertInterval).toBe("function");
  });
});

describe("timescaledb()", () => {
  it("builds an extension definition from a manual config (no client needed)", () => {
    const ext = timescaledb({
      hypertables: [{ table: "SensorReading", column: "time", chunkInterval: "1 day" }],
    });
    expect(ext).toBeTruthy();
  });

  it("accepts an empty config (defaults)", () => {
    expect(timescaledb()).toBeTruthy();
  });
});
