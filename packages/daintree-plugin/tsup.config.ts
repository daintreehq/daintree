import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Emit a bundled .d.ts for the published tarball. `resolve: true` follows
  // the re-export chain from `src/index.ts` and inlines internal types into
  // a single `dist/index.d.ts` — keep `src/index.ts` as the public surface
  // gate; anything re-exported there ships to consumers. `ignoreDeprecations:
  // "6.0"` is scoped to the dts pipeline only: tsup's dts bundler
  // (rollup-plugin-dts) injects a deprecated `baseUrl` which trips TS5101
  // under TypeScript 6. The package's `tsconfig.json` (used by `typecheck`)
  // stays clean. Once TS 7 lands and tsup catches up, the override becomes
  // removable.
  dts: {
    resolve: true,
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  clean: true,
  // `src/cli.ts` carries a `#!/usr/bin/env node` shebang; tsup preserves it and
  // marks the output executable.
  shims: false,
  // `electron` must never be pulled into the standalone CLI bundle. The schema
  // and archive modules we reuse are pure Node, but externalizing electron makes
  // the build fail loudly if that boundary is ever crossed. The declared runtime
  // dependencies (archiver, yauzl, semver, zod, commander, execa, globby,
  // @clack/prompts) resolve from node_modules and stay external by default.
  external: ["electron"],
});
