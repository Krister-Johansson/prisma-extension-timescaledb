import { defineConfig } from "tsup";

// Two builds (SPEC §5 / CLAUDE.md conventions).
//
// 1. The library: dual ESM + CJS for the package "exports" "." (runtime: client extension +
//    types) and "./core" (pure SQL builders, usable directly in hand-written migrations). dts
//    emits .d.ts + .d.cts so both module systems resolve types cleanly (verified by
//    `npm run attw`).
// 2. The Prisma generator binary (has its own shebang), spawned by `prisma generate` through
//    the "bin" entry, which points at the ESM file. It is not exported, so it needs neither a
//    CJS twin nor type declarations; shipping those made up a quarter of the tarball (#166).
//
// No source maps in the published build: they weighed more than the code and nothing in the
// package resolves them (the maps that mattered for a debugger, the generator's, pointed at
// sources the tarball does not carry).
//
// tsup runs the two configs in parallel, so neither cleans dist (the first's clean could race
// the second's write); the build script empties dist before tsup starts.
const shared = {
  target: "es2022",
  outDir: "dist",
  sourcemap: false,
  // Never bundle Prisma — it's a peer dependency (CLAUDE.md).
  external: ["@prisma/client", "prisma", "@prisma/generator-helper", "@prisma/internals"],
} as const;

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/index.ts",
      "core/index": "src/core/index.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
  },
  {
    ...shared,
    entry: { "generator/index": "src/generator/index.ts" },
    format: ["esm"],
    dts: false,
  },
]);
