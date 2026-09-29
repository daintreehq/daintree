import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../../vitest.config";

// mergeConfig concatenates arrays, so `include` is overwritten afterwards —
// merged, it would drag in the whole suite.
const config = mergeConfig(baseConfig, defineConfig({ test: { maxWorkers: 1 } }));
config.test!.include = ["src/hooks/__bench__/*.bench.tsx"];

export default config;
