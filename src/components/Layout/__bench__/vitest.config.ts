import { defineConfig, mergeConfig } from "vitest/config";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import baseConfig from "../../../../vitest.config";

// The dock render-count bench only means something with the React Compiler on:
// production memoizes JSX children, so an uncompiled run would charge every
// parent re-render to each child and swamp the subscription signal.
// mergeConfig concatenates arrays, so `include` is overwritten afterwards —
// merged, it would drag in the whole suite.
const config = mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      babel({ presets: [reactCompilerPreset({ compilationMode: "infer", target: "19" })] }),
    ],
    test: { maxWorkers: 1 },
  })
);
config.test!.include = ["src/components/Layout/__bench__/*.bench.tsx"];

export default config;
