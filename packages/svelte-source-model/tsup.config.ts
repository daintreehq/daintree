import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: {
    resolve: true,
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  clean: true,
  // The Svelte compiler is the one real dependency and it is large. Keeping it
  // external means the consumer, whose own esbuild bundle takes it in, decides
  // when it loads: every consumer reaches this package behind a dynamic import
  // so the compiler never sits on an eager path.
  external: ["svelte", "svelte/compiler"],
});
