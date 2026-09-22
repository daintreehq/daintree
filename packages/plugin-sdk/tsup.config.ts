import { defineConfig, type Options } from "tsup";

const sharedDts = {
  resolve: true,
  compilerOptions: { ignoreDeprecations: "6.0" },
} as const;

const shared = {
  format: ["esm"],
  target: "node22",
  platform: "node",
  // `clean` is off on both configs and the `build` script empties `dist/`
  // instead: tsup builds an array of configs concurrently, so a `clean: true`
  // on either one can delete the other's freshly written output.
  clean: false,
  dts: sharedDts,
  external: ["zod", "react"],
} satisfies Options;

// One JS build for all four entries, but the `testing` declarations come from
// a second, dts-only pass. When `testing` shares a dts bundle with `index`,
// tsup's dts bundler hoists their common `shared/types/plugin` declarations
// into a chunk file and `dist/index.d.ts` collapses to a handful of re-export
// lines — which empties the committed API snapshot (`api-report/index.d.ts`)
// and blinds `check:api-surface`. Splitting only the declarations keeps every
// entry self-contained, as the old standalone plugin-testing package's were,
// while the single JS pass keeps one `metafile-esm.json` covering every entry
// (`__tests__/reactExternal.test.ts` reads it).
//
// A function rather than an array so a `--no-dts` run (the React-externals test
// builds the JS this way) gets ONE config: tsup applies that CLI override to
// every config in an array, which would turn the dts-only pass into a second
// JS build of `testing` racing the first over `dist/` and the metafile.
export default defineConfig((override) => {
  const js = {
    ...shared,
    entry: {
      index: "src/index.ts",
      react: "src/react.ts",
      files: "src/files.ts",
      testing: "src/testing.ts",
    },
    dts: {
      ...shared.dts,
      entry: { index: "src/index.ts", react: "src/react.ts", files: "src/files.ts" },
    },
  } satisfies Options;
  if (override.dts === false) return js;
  return [
    js,
    {
      ...shared,
      // `createMockHost`, folded in from the former plugin-testing package. Its
      // `registerHandler` surfaces `PluginChannelSchema`, so `zod` stays external
      // here for the same reason as below.
      entry: { testing: "src/testing.ts" },
      dts: { ...shared.dts, only: true },
    },
  ];
});

// Notes on the shared options above.
//
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
//
// Both entries in `external` are also `peerDependencies`, which tsup auto-externalizes
// on its own (as `^name($|/|\\)` regexes, so subpaths like
// `react/jsx-runtime` are covered without listing them). The two mechanisms
// are redundant on purpose: the peer declaration is the consumer-facing
// contract and the regex form that catches subpaths, while this list states
// the intent at the build config and holds even if the manifest is edited.
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
