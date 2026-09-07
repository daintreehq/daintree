// Type surface for plugin-style-contract.mjs so vite.config.ts (type-checked
// under tsconfig.node.json, no allowJs) can import it. The .mjs stays plain JS
// so vitest.config.ts — which is not type-checked — can import the same module.
import type { Plugin } from "vite";

/** Specifier the renderer's Tailwind adapter imports the contract stylesheets from. */
export const PLUGIN_STYLE_CONTRACT_MODULE_ID: "virtual:daintree-plugin-style-contract";

/** Absolute paths of every stylesheet inlined into the virtual module. */
export function pluginStyleContractSources(): string[];

/** Vite plugin exposing {@link PLUGIN_STYLE_CONTRACT_MODULE_ID}. */
export function pluginStyleContract(): Plugin;
