// Lets a zero-build plugin (hand-written ESM, no node_modules) import the SDK's
// runtime helpers in its worker. Bare specifiers resolve from the plugin's own
// directory, where nothing is installed, so without this every such plugin
// re-implements frontmatter parsing and the checked-write retry loop by hand.
//
// Kept to Node builtins: the worker bootstrap installs it before anything else
// is imported.

import { registerHooks, type ResolveFnOutput, type ResolveHookSync } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SDK_PACKAGE = "@daintreehq/plugin-sdk";

/** Specifier → file in the app's SDK copy (`dist-electron/electron/plugin-sdk/`). */
export const HOST_SERVED_SDK_ENTRIES: Readonly<Record<string, string>> = {
  [SDK_PACKAGE]: "index.js",
  [`${SDK_PACKAGE}/files`]: "files.js",
  [`${SDK_PACKAGE}/data`]: "data.js",
};

const REFUSED_SDK_ENTRIES: Readonly<Record<string, string>> = {
  [`${SDK_PACKAGE}/react`]:
    "it is for panel views, which get React from the host's import map, and only resolves in a view bundled with @daintreehq/plugin-vite",
  [`${SDK_PACKAGE}/testing`]: "it is a test-time mock host, not something a running plugin loads",
};

// Only these mean "there is no SDK of the plugin's own to use". Any other
// failure is the plugin's own install being broken, which it should see.
const FALL_BACK_ON = new Set(["ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED"]);

function isSdkSpecifier(specifier: string): boolean {
  return specifier === SDK_PACKAGE || specifier.startsWith(`${SDK_PACKAGE}/`);
}

function notServed(specifier: string): Error {
  const reason = REFUSED_SDK_ENTRIES[specifier];
  const served = Object.keys(HOST_SERVED_SDK_ENTRIES).join(", ");
  const message =
    `Cannot find module '${specifier}'. Without an install, Daintree serves only ${served} ` +
    `to plugin workers` +
    (reason ? `; ${specifier} is not served because ${reason}.` : ".") +
    ` To use it, install @daintreehq/plugin-sdk in the plugin and bundle it.`;
  return Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" });
}

/**
 * The resolve hook, separate from its installation so it can be exercised
 * without touching the process's loader. A plugin that installed or bundled
 * its own SDK resolves to that copy; the app's copy is only the fallback.
 */
export function createPluginSdkResolveHook(sdkDir: string): ResolveHookSync {
  return (specifier, context, nextResolve): ResolveFnOutput => {
    if (!isSdkSpecifier(specifier)) return nextResolve(specifier, context);
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== "string" || !FALL_BACK_ON.has(code)) throw error;
      const file = HOST_SERVED_SDK_ENTRIES[specifier];
      if (!file) throw notServed(specifier);
      return {
        url: pathToFileURL(path.join(sdkDir, file)).href,
        format: "module",
        shortCircuit: true,
      };
    }
  };
}

/**
 * Install the fallback for this process. `registerHooks` runs the hook
 * in-thread and synchronously — no loader worker and no separate hook module
 * to ship — and covers `require()` as well as `import`.
 */
export function installPluginSdkResolution(sdkDir: string): void {
  registerHooks({ resolve: createPluginSdkResolveHook(sdkDir) });
}
