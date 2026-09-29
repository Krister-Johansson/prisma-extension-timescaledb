import { defineConfig } from "vitest/config";

// Integration tests: real TimescaleDB via Testcontainers. Long timeouts (image start +
// prisma CLI + migrations). Files run in parallel: each file starts and stops its own
// container, so nothing is shared between them but the Docker daemon, and per-container
// settings (max_connections, the background-worker budget, ALTER ROLE defaults) stay
// contained. Four workers is where the run stops getting faster on a 10-CPU machine
// (145s sequential, 52s at four on vitest 5; issue #133 measured no gain past four).
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    maxWorkers: 4,
  },
});
