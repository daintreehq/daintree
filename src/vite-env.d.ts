/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS?: string;
  readonly DAINTREE_PERF_CAPTURE?: string;
  readonly DAINTREE_VERBOSE?: string;
  readonly DAINTREE_DISABLE_FOCUSED_DRAIN_PRIORITY?: string;
  readonly DAINTREE_PAINT_FABRIC?: string;
  readonly DAINTREE_PAINT_FABRIC_SURFACES?: string;
  readonly DAINTREE_PAINT_FABRIC_WORKER_INGEST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Stylesheets the renderer's plugin Tailwind compiler compiles against, inlined
 * at build time by `scripts/lib/plugin-style-contract.mjs`. See that module for
 * why these do not arrive as `?raw` imports.
 */
declare module "virtual:daintree-plugin-style-contract" {
  /** The host's `@theme` / `@custom-variant` blocks — `src/styles/design-contract.css`. */
  export const designContractCss: string;
  /** Tailwind's stock theme, imported as `reference` so it emits nothing. */
  export const tailwindThemeCss: string;
  /** Tailwind's `@tailwind utilities;` entry. */
  export const tailwindUtilitiesCss: string;
  /** `tw-animate-css`, an approved extension of the plugin vocabulary. */
  export const twAnimateCss: string;
}
