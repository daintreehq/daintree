// Type surface for main-bundle.mjs so type-checked tests can build with the
// same externals and stubs as the app build.

import type { Plugin } from "esbuild";

/** Packages the main-process bundle leaves to Node's resolver at runtime. */
export const MAIN_BUNDLE_EXTERNAL: string[];

/** Stubs zod's locale namespace and conf's ajv imports out of the bundle. */
export function mainBundleStubsPlugin(): Plugin;

/** The `@vue/{compiler-dom,compiler-core,shared}/index.js` files that pick a build by `NODE_ENV`. */
export const VUE_ENV_SWITCH_FILTER: RegExp;

/** Folds those files' `NODE_ENV` switch so only Vue's production compiler is bundled. */
export function vueProductionCompilerPlugin(): Plugin;

/** The main ESM build's plugins: the stubs, plus the Vue plugin in production. */
export function mainBundlePlugins(options: { isProd: boolean }): Plugin[];
