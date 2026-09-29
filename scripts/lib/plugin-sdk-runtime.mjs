/**
 * The SDK entries the plugin worker serves to a plugin with no SDK of its own
 * (`electron/services/plugin/pluginSdkResolution.ts` maps the specifiers to
 * these files). Built from source rather than copied from
 * `packages/plugin-sdk/dist`, which the app build never produces, and with
 * every dependency bundled in (`yaml` for `data`), since nothing beside the
 * output can resolve a bare import. `react` and `testing` are withheld on
 * purpose; the resolver refuses them by name.
 */
export const PLUGIN_SDK_RUNTIME_ENTRIES = {
  index: "packages/plugin-sdk/src/index.ts",
  files: "packages/plugin-sdk/src/files.ts",
  data: "packages/plugin-sdk/src/data.ts",
};

export const PLUGIN_SDK_RUNTIME_OUTDIR = "dist-electron/electron/plugin-sdk";

/**
 * Self-contained, one file per entry: the worker loads them straight from the
 * app (inside the ASAR when packaged, which Electron's ESM loader reads like
 * the worker's own bundles), so there is no chunk graph to keep in step.
 */
export function pluginSdkRuntimeBuildConfig(options = {}) {
  return {
    entryPoints: PLUGIN_SDK_RUNTIME_ENTRIES,
    outdir: PLUGIN_SDK_RUNTIME_OUTDIR,
    bundle: true,
    format: "esm",
    // Neutral, not node: under the `node` condition `yaml` resolves to its
    // CommonJS build, whose `require("process")` has no `require` to call in
    // an ESM bundle. The neutral build takes its pure ESM `default` export.
    platform: "neutral",
    target: "node22",
    minify: options.minify === true,
    sourcemap: false,
    logLevel: "info",
    ...(options.absWorkingDir ? { absWorkingDir: options.absWorkingDir } : {}),
  };
}
