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
  // external means the consumer (the built-in plugin, bundled by esbuild into
  // the main process) decides when it loads — the plugin `await import()`s this
  // package lazily so the compiler never sits on the eager main-process path.
  external: ["svelte", "svelte/compiler"],
});
