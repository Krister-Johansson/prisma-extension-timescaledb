import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(() => assertSupportedPrismaVersion("8.0.0")).toThrow(/npm install -D prisma@7 @prisma\/client@7/);
    // Issue #191: Prisma 8 has no $extends, so the message must not promise that the client
    // extension keeps working there, nor a release of this package that supports it.
    expect(() => assertSupportedPrismaVersion("8.0.0")).not.toThrow(/client extension keeps working/);
    expect(() => assertSupportedPrismaVersion("8.0.0")).not.toThrow(/release that supports Prisma 8/);
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

  // Issue #191: Prisma's incremental upgrade guide keeps the Prisma 7 CLI as @prisma/prisma7
  // (binary `prisma7`) beside a root `prisma` 8. Prisma 8 has no generator protocol, so the
  // CLI that spawned the generator there is the wrapper's, and its version is the one to guard.
  describe("with the @prisma/prisma7 wrapper installed", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function project(packages: Record<string, string>): string {
      const root = mkdtempSync(join(tmpdir(), "petdb-prisma-version-"));
      dirs.push(root);
      for (const [name, version] of Object.entries(packages)) {
        const dir = join(root, "node_modules", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
      }
      return pathToFileURL(join(root, "index.js")).href;
    }

    it("prefers the wrapper's supported version over a root prisma of another major", () => {
      const from = project({ prisma: "8.0.0-rc.33", "@prisma/prisma7": "7.10.1" });
      expect(installedPrismaVersion(from)).toBe("7.10.1");
      expect(assertSupportedPrismaVersion(installedPrismaVersion(from))).toBeUndefined();
    });

    it("uses the wrapper when no root prisma resolves", () => {
      expect(installedPrismaVersion(project({ "@prisma/prisma7": "7.10.1" }))).toBe("7.10.1");
    });

    it("keeps the root prisma when it is the supported major", () => {
      expect(installedPrismaVersion(project({ prisma: "7.4.2", "@prisma/prisma7": "7.10.1" }))).toBe("7.4.2");
    });

    it("still reports a root prisma of another major when there is no wrapper", () => {
      const from = project({ prisma: "8.0.0-rc.33" });
      expect(installedPrismaVersion(from)).toBe("8.0.0-rc.33");
      expect(() => assertSupportedPrismaVersion(installedPrismaVersion(from))).toThrow(/prisma 8.0.0-rc.33 is installed/);
    });

    it("ignores a wrapper whose own version is outside the supported major", () => {
      expect(installedPrismaVersion(project({ prisma: "8.0.0", "@prisma/prisma7": "9.0.0" }))).toBe("8.0.0");
    });
  });
});

// Issue #191: Prisma 8 is a rewrite without generators or $extends, so the peer ranges must
// stop below it. An open `>=7.0.0` would accept 8.0.0 on the day Prisma publishes it.
describe("peer ranges", () => {
  it("cap prisma and @prisma/client below the next major", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      peerDependencies: Record<string, string>;
    };
    const range = `>=${SUPPORTED_PRISMA_MAJOR}.0.0 <${SUPPORTED_PRISMA_MAJOR + 1}`;
    expect(pkg.peerDependencies["prisma"]).toBe(range);
    expect(pkg.peerDependencies["@prisma/client"]).toBe(range);
  });
});
