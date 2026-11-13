import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notice } from "../../src/generator/notice.js";

// Issue #192: Prisma shows a generator's stdout and hides its stderr on a successful run, so a
// notice has to be written to stdout. The integration suite checks the real `prisma generate`
// output (evolution.test.ts); these pin the two halves that make it true.
describe("generator notices", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the message to stdout as one line, and nothing to stderr", () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    notice("prisma-extension-timescaledb: something to know");
    expect(out).toHaveBeenCalledExactlyOnceWith("prisma-extension-timescaledb: something to know\n");
    expect(err).not.toHaveBeenCalled();
  });

  it("is the only way the generator prints: no console call or stderr write in src/generator", () => {
    const dir = new URL("../../src/generator/", import.meta.url);
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => /\bconsole\.\w+\(|process\.stderr/.test(readFileSync(new URL(file, dir), "utf8")));
    expect(offenders).toEqual([]);
  });
});
