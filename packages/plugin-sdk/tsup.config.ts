import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // The `index` entry is a near types-only barrel (`export type *` plus a
  // handful of explicit runtime const re-exports), but `react` is NOT: it ships
  // real hook implementations, so `dist/react.js` carries actual code and the
  // externals below are load-bearing rather than cosmetic.
  //
  // `resolve: true` follows the re-export chain into `shared/types/*.ts` and
  // inlines those internal types into the published declarations — without it
  // the `.d.ts` would point at `../../shared/...` paths that don't exist in a
  // consumer's node_modules. `ignoreDeprecations: "6.0"` is scoped to the dts
  // pipeline only: tsup's dts bundler (rollup-plugin-dts) injects a deprecated
  // `baseUrl` that trips TS5101 under TypeScript 6. The package's
  // `tsconfig.json` (used by `typecheck`) stays clean. Mirrors
  // `packages/daintree-plugin/tsup.config.ts`.
  dts: {
    resolve: true,
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  clean: true,
  // Both entries here are also `peerDependencies`, which tsup already
  // auto-externalizes (as `^name($|/|\\)` regexes, so subpaths like
  // `react/jsx-runtime` are covered too). Listing them again is documentation,
  // not mechanism — the peer declaration in `package.json` is what actually
  // keeps them out of the bundle, for the esbuild JS pass and the dts pass
  // alike. Removing them from `peerDependencies` would silently re-inline them.
  //
  // `zod`: `PluginChannelSchema` is public surface typed as `z.ZodType<T>`.
  // Without keeping zod external, the dts bundler inlines zod's CJS runtime and
  // mangles the qualified `z.ZodType` reference into invalid `undefined<T>`
  // syntax. Externalizing it emits a clean `import type { z } from "zod"`.
  //
  // `react`: the `react` entry's hooks import `useState`/`useEffect`/etc. for
  // real. Bundling React here would inline a *second* React copy (and, since
  // `process.env.NODE_ENV` is undefined in a browser panel bundle, the
  // development build) alongside the host's own instance — plugin views resolve
  // bare `react` to the host's single copy via the import map, so a bundled
  // copy means two Reacts and `Invalid hook call` (#11296). This is the same
  // contract `@daintreehq/plugin-vite` enforces on the consumer side.
  external: ["zod", "react"],
});
