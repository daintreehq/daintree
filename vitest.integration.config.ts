import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "path";

export default defineConfig(({ mode }) => {
  // Load environment variables from .env file
  const env = loadEnv(mode, process.cwd(), "");

  return {
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@shared": path.resolve(__dirname, "./shared"),
      },
    },
    test: {
      globals: true,
      environment: "node",
      // Only include integration tests
      include: ["**/*.integration.test.{js,ts}"],
      exclude: ["node_modules", "dist", "dist-electron", "build", "release"],
      // Higher timeout for API calls (60 seconds per test)
      testTimeout: 60000,
      // Hook timeout for setup/teardown
      hookTimeout: 30000,
      // Run integration tests sequentially to avoid rate limiting
      pool: "forks",
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
      env: {
        NODE_ENV: "test",
        // Pass through API keys from environment (only if defined)
        ...(env.FIREWORKS_API_KEY && { FIREWORKS_API_KEY: env.FIREWORKS_API_KEY }),
        ...(env.FIREWORKS_AI_KEY && { FIREWORKS_AI_KEY: env.FIREWORKS_AI_KEY }),
      },
    },
  };
});
