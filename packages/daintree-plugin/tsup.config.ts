import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // No .d.ts emit — create-daintree-plugin resolves daintree-plugin's types via
  // the package's `exports.types` → `src/index.ts` condition (source), so a
  // built declaration is unnecessary and avoids a TS6-deprecation build failure.
  dts: false,
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
