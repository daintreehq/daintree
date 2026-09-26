// Type surface for plugin-sdk-runtime.mjs so the type-checked resolver test can
// build the same SDK copy the app build emits.

import type { BuildOptions } from "esbuild";

/** Output file name (without `.js`) → SDK source entry, repo-relative. */
export const PLUGIN_SDK_RUNTIME_ENTRIES: Readonly<Record<"index" | "files" | "data", string>>;

/** Repo-relative directory the app build writes the SDK copy to. */
export const PLUGIN_SDK_RUNTIME_OUTDIR: string;

/** The esbuild options for the SDK copy the plugin worker serves. */
export function pluginSdkRuntimeBuildConfig(options?: {
  minify?: boolean;
  absWorkingDir?: string;
}): BuildOptions;
