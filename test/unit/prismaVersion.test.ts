import { describe, expect, it } from "vitest";
import {
  assertSupportedPrismaVersion,
  installedPrismaVersion,
  SUPPORTED_PRISMA_MAJOR,
} from "../../src/generator/prismaVersion.js";

// Issue #166: the generator reads an internal Prisma API, so a Prisma major it was not built
// for must stop with a message that names the versions instead of a TypeError mid-parse.
describe("assertSupportedPrismaVersion", () => {
  it("accepts every release and pre-release of the supported major", () => {
    expect(SUPPORTED_PRISMA_MAJOR).toBe(7);
    for (const v of ["7.0.0", "7.10.0", "7.99.1", "7.9.1-dev.1", "7.10.0-integration-x.1"]) {
      expect(assertSupportedPrismaVersion(v)).toBeUndefined();
    }
  });

  it("rejects a newer major, naming both versions and the way out", () => {
    expect(() => assertSupportedPrismaVersion("8.1.0-dev.7")).toThrow(
      /prisma 8.1.0-dev.7 is installed, but this release of the generator supports Prisma 7.x only/,
    );
    expect(() => assertSupportedPrismaVersion("8.0.0")).toThrow(/newer prisma-extension-timescaledb release that supports Prisma 8/);
    expect(() => assertSupportedPrismaVersion("8.0.0")).toThrow(/pin prisma to 7.x/);
    expect(() => assertSupportedPrismaVersion("8.0.0")).toThrow(/client extension keeps working/);
  });

  it("rejects an older major with an upgrade, since no release ever supported it", () => {
    expect(() => assertSupportedPrismaVersion("6.19.3")).toThrow(/prisma 6.19.3 is installed/);
    expect(() => assertSupportedPrismaVersion("6.19.3")).toThrow(/Upgrade prisma and @prisma\/client to 7.x/);
    expect(() => assertSupportedPrismaVersion("6.19.3")).not.toThrow(/release that supports Prisma 6/);
  });

  it("warns instead of throwing when the version is unknown, and ignores an unparseable one", () => {
    expect(assertSupportedPrismaVersion(undefined)).toMatch(/could not find the installed prisma package/);
    expect(assertSupportedPrismaVersion("workspace:*")).toBeUndefined();
    expect(assertSupportedPrismaVersion("")).toBeUndefined();
  });
});

describe("installedPrismaVersion", () => {
  // Pins the lookup itself: if prisma ever dropped ./package.json from its exports, the guard
  // would turn into a silent no-op while every other test stayed green.
  it("resolves the prisma package installed next to the caller", () => {
    expect(installedPrismaVersion(import.meta.url)).toMatch(/^7\.\d+\.\d+/);
  });

  it("is undefined where no prisma resolves", () => {
    expect(installedPrismaVersion("file:///nowhere/at/all/index.js")).toBeUndefined();
  });
});
