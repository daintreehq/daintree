import path from "node:path";

/**
 * Packages the main-process bundle leaves to Node's resolver at runtime.
 * Shared by `build-main.mjs` and `build-import-budget.mjs` so the budget graph
 * matches what production actually loads.
 */
export const MAIN_BUNDLE_EXTERNAL = [
  "electron",
  "@parcel/watcher", // Native N-API module (FSEvents)
  "node-pty", // Native module
  "better-sqlite3", // Native module
  "win-job-object", // Native module — Windows-only help-session Job Object (#7526)
  "posix-pty-reaper", // Native module — macOS/Linux help-session PTY supervisor (#8769)
  "copytree", // Externalize to preserve file structure (config files)
  "onnxruntime-node", // Native module — ONNX runtime for Silero VAD (#9177)
  "avr-vad", // Silero VAD wrapper; loads its bundled .onnx via fs from its own dir (#9177)
];

const ZOD_LOCALES_NAMESPACE = "daintree-zod-locales";
const CONF_AJV_NAMESPACE = "daintree-conf-ajv";

// Innermost package only, so conf's own nested dependencies keep the real ajv.
function isInsidePackage(importer, pkg) {
  const normalized = importer.split(path.sep).join("/");
  const marker = "/node_modules/";
  const at = normalized.lastIndexOf(marker);
  return at !== -1 && normalized.slice(at + marker.length).startsWith(`${pkg}/`);
}

/**
 * Drops dead weight that shared chunks would otherwise make every host parse.
 *
 * - zod's `z.locales` / `z.core.locales` namespace re-exports every translated
 *   error map (~260 KB). Nothing calls `z.config(z.locales.xx())`; English is
 *   imported directly by zod's schemas, so only `en` stays reachable.
 * - conf (under electron-store) imports ajv + ajv-formats at top level but only
 *   constructs a validator when a store passes `schema`, `ajvOptions` or
 *   `rootSchema`. None of ours do (`electron/store.ts`, pinned by
 *   `electron/__tests__/storeNoSchemaValidation.test.ts`). Only conf's imports
 *   are stubbed; every other importer gets the real ajv.
 */
export function mainBundleStubsPlugin() {
  return {
    name: "daintree-main-bundle-stubs",
    setup(build) {
      build.onResolve({ filter: /\/locales\/index\.js$/ }, (args) => {
        if (!args.path.startsWith(".") || !isInsidePackage(args.importer, "zod")) return undefined;
        // Keyed by the real locale directory so two zod copies never share one stub.
        return {
          path: path.dirname(path.resolve(args.resolveDir, args.path)),
          namespace: ZOD_LOCALES_NAMESPACE,
        };
      });
      build.onResolve({ filter: /^(ajv\/dist\/2020\.js|ajv-formats)$/ }, (args) => {
        if (!isInsidePackage(args.importer, "conf")) return undefined;
        return { path: args.path, namespace: CONF_AJV_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: ZOD_LOCALES_NAMESPACE }, (args) => ({
        contents: `export { default as en } from "./en.js";`,
        resolveDir: args.path,
        loader: "js",
      }));
      build.onLoad({ filter: /.*/, namespace: CONF_AJV_NAMESPACE }, (args) => {
        const fail = `throw new Error("conf schema validation is stubbed out of the main bundle (scripts/lib/main-bundle.mjs)");`;
        const contents =
          args.path === "ajv-formats"
            ? `export default { default() { ${fail} } };`
            : `export class Ajv2020 { constructor() { ${fail} } }`;
        return { contents, loader: "js" };
      });
    },
  };
}
