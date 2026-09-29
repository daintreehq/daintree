import { mergeConfig } from "vitest/config";
import baseConfig from "../../../../vitest.config";

// mergeConfig concatenates arrays, so `include` is overwritten afterwards —
// merged, it would drag in the whole suite.
const config = mergeConfig(baseConfig, { test: { maxWorkers: 1, testTimeout: 600_000 } });
config.test!.include = ["src/components/Worktree/__bench__/*.bench.tsx"];

export default config;
