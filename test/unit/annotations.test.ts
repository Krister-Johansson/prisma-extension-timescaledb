import { describe, expect, it } from "vitest";
import { findAnnotation, parseAnnotations } from "../../src/generator/annotations.js";

describe("parseAnnotations", () => {
  it("returns nothing for empty/missing docs", () => {
    expect(parseAnnotations(null)).toEqual([]);
    expect(parseAnnotations(undefined)).toEqual([]);
    expect(parseAnnotations("just a normal comment")).toEqual([]);
  });

  it("parses a no-arg annotation", () => {
    expect(parseAnnotations("@timescale.bucket")).toEqual([{ name: "bucket", args: {} }]);
  });

  it("parses string args", () => {
    expect(parseAnnotations(`@timescale.hypertable(column: "time", chunkInterval: "1 day")`)).toEqual([
      { name: "hypertable", args: { column: "time", chunkInterval: "1 day" } },
    ]);
  });

  it("parses a nested object arg (refresh policy)", () => {
    const [ann] = parseAnnotations(
      `@timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })`,
    );
    expect(ann).toEqual({
      name: "continuousAggregate",
      args: {
        source: "SensorReading",
        bucket: "1 hour",
        timeColumn: "time",
        refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" },
      },
    });
  });

  it("ignores surrounding text and finds the annotation", () => {
    const anns = parseAnnotations(`continuous aggregate, surfaced as a view @timescale.aggregate(fn: "avg", column: "temperature")`);
    expect(findAnnotation(anns, "aggregate")).toEqual({ name: "aggregate", args: { fn: "avg", column: "temperature" } });
  });

  it("does not confuse commas inside the nested object with top-level args", () => {
    const [ann] = parseAnnotations(`@timescale.x(a: "1", nested: { b: "2", c: "3" }, d: "4")`);
    expect(ann?.args).toEqual({ a: "1", nested: { b: "2", c: "3" }, d: "4" });
  });
});
