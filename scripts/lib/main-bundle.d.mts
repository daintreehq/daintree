// Type surface for main-bundle.mjs so type-checked tests can build with the
// same externals and stubs as the app build.

import type { Plugin } from "esbuild";

/** Packages the main-process bundle leaves to Node's resolver at runtime. */
export const MAIN_BUNDLE_EXTERNAL: string[];

/** Stubs zod's locale namespace and conf's ajv imports out of the bundle. */
export function mainBundleStubsPlugin(): Plugin;
