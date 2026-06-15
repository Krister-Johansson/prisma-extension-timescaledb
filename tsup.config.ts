import { defineConfig } from "tsup";

// Dual ESM + CJS build (SPEC §5 / CLAUDE.md conventions). Two entry points map to the
// package "exports": "." (runtime: client extension + types) and "./core" (pure SQL
// builders, usable directly in hand-written migrations). dts emits .d.ts + .d.cts so both
// module systems resolve types cleanly (verified by `npm run attw`).
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    // Prisma generator binary (has its own shebang); spawned by `prisma generate`.
    "generator/index": "src/generator/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  outDir: "dist",
  // Never bundle Prisma — it's a peer dependency (CLAUDE.md).
  external: ["@prisma/client", "prisma", "@prisma/generator-helper", "@prisma/internals"],
});
