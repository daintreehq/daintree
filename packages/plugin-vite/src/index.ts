import type { Plugin } from "vite";

/**
 * Rolldown/Rollup external patterns that strip React, ReactDOM, and every
 * documented subpath (`react/jsx-runtime`, `react/jsx-dev-runtime`,
 * `react-dom/client`, …) from plugin bundles. The regex form covers future
 * subpaths automatically — Rolldown does NOT auto-include subpaths when
 * `external` lists only the bare package name (e.g. `external: ["react"]`
 * matches the literal string `"react"` and bundles `react/jsx-runtime` into
 * the plugin output, producing a second React copy and `Invalid hook call`
 * at runtime).
 *
 * Paired with the host import map (injected into Daintree's index.html), the
 * stripped imports resolve at load time to Daintree's single `vendor-react`
 * chunk, sharing one React instance across the host and every loaded plugin.
 */
export const reactExternals: readonly RegExp[] = [/^react($|\/)/, /^react-dom($|\/)/] as const;

export interface DaintreePluginOptions {
  /**
   * Extra externals to merge with the React preset. Useful when a plugin
   * needs to externalize additional host-provided modules (e.g. a future
   * shared component library).
   */
  readonly externals?: ReadonlyArray<string | RegExp>;
}

/**
 * Vite plugin that wires the React externals preset into a plugin's build.
 *
 * Usage in a plugin's vite.config.ts:
 *
 * ```ts
 * import { daintreePlugin } from "@daintreehq/plugin-vite";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   plugins: [daintreePlugin()],
 *   build: { lib: { entry: "src/index.tsx", formats: ["es"] } },
 * });
 * ```
 *
 * The plugin uses the `config` hook (merge semantics) rather than
 * `configResolved` (read-only) so consumer-supplied externals are preserved.
 */
export function daintreePlugin(options: DaintreePluginOptions = {}): Plugin {
  const extras = options.externals ?? [];
  return {
    name: "daintree-plugin-vite",
    config: () => ({
      build: {
        rollupOptions: {
          external: [...reactExternals, ...extras],
        },
      },
    }),
  };
}
