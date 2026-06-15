import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live in test/unit; integration tests (Testcontainers, Milestone 5) will
    // live in test/integration and run separately.
    include: ["test/unit/**/*.test.ts"],
  },
});
