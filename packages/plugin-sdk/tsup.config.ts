import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Types-only barrel: the entries re-export with `export type *`, so the
  // emitted `dist/*.js` are effectively empty and the `dist/*.d.ts` carry the
  // whole surface. `resolve: true` follows the re-export chain into
  // `shared/types/*.ts` and inlines those internal types into the published
  // declarations — without it the `.d.ts` would point at `../../shared/...`
  // paths that don't exist in a consumer's node_modules. `ignoreDeprecations:
  // "6.0"` is scoped to the dts pipeline only: tsup's dts bundler
  // (rollup-plugin-dts) injects a deprecated `baseUrl` that trips TS5101 under
  // TypeScript 6. The package's `tsconfig.json` (used by `typecheck`) stays
  // clean. Mirrors `packages/daintree-plugin/tsup.config.ts`.
  dts: {
    resolve: true,
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  clean: true,
  // `PluginChannelSchema` is public surface typed as `z.ZodType<T>`. Without
  // keeping zod external, the dts bundler inlines zod's CJS runtime and mangles
  // the qualified `z.ZodType` reference into invalid `undefined<T>` syntax.
  // Externalizing it emits a clean `import type { z } from "zod"` — zod is a
  // peer dependency plugin authors already have for authoring schemas.
  external: ["zod"],
});
