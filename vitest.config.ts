import { defineConfig } from "vitest/config";
import { availableParallelism } from "os";
import path from "path";
// Same virtual module the renderer build uses for the plugin Tailwind
// compiler's stylesheets. Without it the adapter's contract tests compile
// against empty strings: Vitest stubs every `.css` specifier — `?raw` included
// — so the bytes have to arrive as a virtual JS module instead.
import { pluginStyleContract } from "./scripts/lib/plugin-style-contract.mjs";

export default defineConfig({
  plugins: [pluginStyleContract()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    onConsoleLog: () => false,
    // Pool stays at the default (forks). The threads pool was tried for lower
    // per-file overhead, but @parcel/watcher's native addon (pulled in
    // transitively by the file-watching services) is not context-aware and
    // fails with "Module did not self-register" when loaded into a second
    // worker_thread on Linux. Forks give each worker its own process, sidestep
    // that, and the headline speedup is the 4-way sharding in ci.yml — not the
    // pool. minWorkers is left unset so workers track CPU count (the old
    // minWorkers:3 forced 3 workers even on the 2-core CI runners). Cap the
    // upper bound because high-core hosts can otherwise overwhelm Vitest's RPC
    // teardown and turn an all-passing run into an EnvironmentTeardownError.
    // Take the min with the core count so this only ever *lowers* the worker
    // count on big machines — a bare `maxWorkers: 8` would instead force 8
    // fork processes onto the 4-core CI shards, oversubscribing them 2x and
    // timing out the import-heavy suites.
    maxWorkers: Math.min(availableParallelism(), 8),
    maxConcurrency: 10,
    include: [
      "electron/**/*.{test,spec}.{js,ts}",
      "src/**/*.{test,spec}.{js,ts,jsx,tsx}",
      "shared/**/*.{test,spec}.{js,ts}",
      "scripts/**/*.{test,spec}.{js,ts,mjs}",
      "e2e/helpers/__tests__/*.{test,spec}.{js,ts}",
      "plugins/**/*.{test,spec}.{js,ts,jsx,tsx}",
      "packages/**/*.{test,spec}.{js,ts,jsx,tsx}",
    ],
    exclude: [
      "node_modules",
      "dist",
      "dist-electron",
      "build",
      "release",
      "**/*.integration.test.{js,ts}",
    ],
    testTimeout: 15000,
    // Paired with testTimeout the way vitest.integration.config.ts pairs its
    // own. Left unset, hooks keep vitest's 10s default, so a `beforeAll` that
    // does strictly more work than any single test in its file gets less time
    // than one: the action suites reset the module graph and re-import every
    // definition cold, which is the heaviest thing in those files. That fits
    // easily in 10s on a warm machine and only misses it under CI contention,
    // which makes it a shard-ordering lottery rather than a real signal.
    hookTimeout: 15000,
    env: {
      NODE_ENV: "development",
    },
  },
});
