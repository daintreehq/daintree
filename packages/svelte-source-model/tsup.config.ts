import { defineConfig } from "tsup";

export default defineConfig({
  // `compiler-parse` is its own file so `index.js` reaches `svelte/compiler`
  // only through `import("./compiler-parse.js")`, never statically. Splitting
  // is what keeps that import an edge rather than inlining it.
  entry: {
    index: "src/index.ts",
    "compiler-parse": "src/compiler-parse.ts",
  },
  format: ["esm"],
  splitting: true,
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
