import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // `vite` is a peer dependency supplied by the plugin author's build — never
  // bundle it. `ignoreDeprecations: "6.0"` is scoped to the dts pipeline only
  // (see `packages/daintree-plugin/tsup.config.ts` for the full rationale).
  dts: {
    resolve: true,
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  clean: true,
  external: ["vite"],
});
