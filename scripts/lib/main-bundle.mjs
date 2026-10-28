import fs from "node:fs";
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
  "mac-phys-footprint", // Native module — macOS physical-footprint reader (#13526)
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

/** The entry files of the Vue packages whose `index.js` picks a build by `NODE_ENV`, nested copies included. */
export const VUE_ENV_SWITCH_FILTER =
  /[\\/]node_modules[\\/]@vue[\\/](compiler-dom|compiler-core|shared)[\\/]index\.js$/;

const VUE_PRODUCTION_TEST = /process\.env\.NODE_ENV\s*===\s*(["'])production\1/g;

/**
 * Bundles only the production build of Vue's template compiler.
 *
 * Each of `@vue/compiler-dom`, `@vue/compiler-core` and `@vue/shared` has an
 * `index.js` that requires its `.cjs.prod.js` or `.cjs.js` build by
 * `process.env.NODE_ENV`. A Node bundle leaves that read to runtime, so both
 * builds ship (~120 KB of dead weight in the compiler chunk), and a packaged
 * app, which never sets `NODE_ENV`, runs the development one. This folds the
 * switch in those three files alone, so esbuild drops the development
 * require; every other `NODE_ENV` read in main still happens at runtime.
 */
export function vueProductionCompilerPlugin() {
  return {
    name: "daintree-vue-production-compiler",
    setup(build) {
      build.onLoad({ filter: VUE_ENV_SWITCH_FILTER }, async (args) => {
        const source = await fs.promises.readFile(args.path, "utf8");
        const contents = source.replace(VUE_PRODUCTION_TEST, "true");
        // Loud rather than silently shipping both builds again after a Vue upgrade.
        if (contents === source) {
          return {
            errors: [
              {
                text: `${args.path} no longer switches on process.env.NODE_ENV === "production"; update vueProductionCompilerPlugin (scripts/lib/main-bundle.mjs)`,
              },
            ],
          };
        }
        return {
          contents,
          loader: "js",
          resolveDir: path.dirname(args.path),
        };
      });
    },
  };
}

/** The main ESM build's plugins, shared with the tests that check what it emits. */
export function mainBundlePlugins({ isProd }) {
  return [mainBundleStubsPlugin(), ...(isProd ? [vueProductionCompilerPlugin()] : [])];
}
