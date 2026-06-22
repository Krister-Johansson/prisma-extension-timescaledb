import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live in test/unit; integration tests (Testcontainers, Milestone 5) will
    // live in test/integration and run separately.
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // json-summary + json feed the PR coverage comment (vitest-coverage-report-action);
      // lcov feeds Codecov; html/text are for local/CI artifact inspection.
      reporter: ["text", "text-summary", "html", "lcov", "json-summary", "json"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      exclude: [
        // Generator bin/handler entry: registers a JSON-RPC handler at import and is
        // exercised end-to-end by the integration suite, not unit tests.
        "src/generator/index.ts",
        // Type-only module (interfaces) — no executable code to cover.
        "src/core/types.ts",
      ],
      // Unit-suite gate (no Docker). The client runtime wiring in src/client/index.ts is
      // additionally covered by the integration suite; thresholds sit below the unit numbers
      // for headroom.
      thresholds: {
        statements: 88,
        branches: 85,
        // vitest 4's v8 provider counts more functions (closures/arrows) than v3 did, so the
        // same suite reads lower here; the integration suite covers the rest of the runtime.
        functions: 85,
        lines: 88,
      },
    },
  },
});
