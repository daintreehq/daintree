import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  // `createMockHost` is the only runtime export; everything else is `import
  // type`. `resolve: true` inlines the cross-boundary `shared/types/*.ts`
  // declarations into `dist/index.d.ts` so the published tarball doesn't
  // reference `../../shared/...` paths absent from a consumer's node_modules.
  // `ignoreDeprecations: "6.0"` is scoped to the dts pipeline only (see
  // `packages/daintree-plugin/tsup.config.ts` for the full rationale).
  dts: {
    resolve: true,
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
  clean: true,
  // The mock's `registerHandler` signature surfaces `PluginChannelSchema`
  // (`z.ZodType<T>`). Keep zod external so the dts bundler emits a clean
  // `import type { z } from "zod"` instead of inlining zod's CJS runtime and
  // mangling the qualified reference. See plugin-sdk/tsup.config.ts.
  external: ["zod"],
});
