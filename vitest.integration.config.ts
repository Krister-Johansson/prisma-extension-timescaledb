import { defineConfig } from "vitest/config";

// Integration tests: real TimescaleDB via Testcontainers. Long timeouts (image start +
// prisma CLI + migrations), no file parallelism (each test owns a container).
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
