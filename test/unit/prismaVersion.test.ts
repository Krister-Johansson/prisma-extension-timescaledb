import { describe, expect, it } from "vitest";
import { assertSupportedPrismaVersion, SUPPORTED_PRISMA_MAJOR } from "../../src/generator/prismaVersion.js";

// Issue #166: the generator reads an internal Prisma API, so a Prisma major it was not built
// for must stop with a message that names the versions instead of a TypeError mid-parse.
describe("assertSupportedPrismaVersion", () => {
  it("accepts every release and pre-release of the supported major", () => {
    expect(SUPPORTED_PRISMA_MAJOR).toBe(7);
    for (const v of ["7.0.0", "7.10.0", "7.99.1", "7.9.1-dev.1", "7.10.0-integration-x.1"]) {
      expect(() => assertSupportedPrismaVersion(v)).not.toThrow();
    }
  });

  it("rejects an older or newer major, naming both versions", () => {
    expect(() => assertSupportedPrismaVersion("8.1.0-dev.7")).toThrow(/prisma 8.1.0-dev.7 is installed, but this release of the generator supports Prisma 7.x only/);
    expect(() => assertSupportedPrismaVersion("8.0.0")).toThrow(/supports Prisma 8/);
    expect(() => assertSupportedPrismaVersion("6.19.3")).toThrow(/pin prisma to 7.x/);
    expect(() => assertSupportedPrismaVersion("6.19.3")).toThrow(/client extension keeps working/);
  });

  it("leaves an unknown or unparseable version alone", () => {
    expect(() => assertSupportedPrismaVersion(undefined)).not.toThrow();
    expect(() => assertSupportedPrismaVersion("workspace:*")).not.toThrow();
    expect(() => assertSupportedPrismaVersion("")).not.toThrow();
  });
});
