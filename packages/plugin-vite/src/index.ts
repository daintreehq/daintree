import { builtinModules } from "node:module";
import type { Plugin } from "vite";

/**
 * The exact React specifiers the Daintree host import map serves. This is the
 * single source of truth for the host/plugin contract: `vite.config.ts` imports
 * this list to build the `<script type="importmap">` it injects, and the plugin
 * build (below) errors at build time on any React subpath outside it. Keeping
 * the two sides on one constant is what stops the "externalized but unresolved
 * at runtime" drift (e.g. `react-dom/server`) that this list previously had to
 * be hand-synced against.
 */
export const HOST_IMPORTMAP_SPECIFIERS = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
] as const;

/**
 * Rolldown/Rollup external patterns that strip React, ReactDOM, and every
 * subpath (`react/jsx-runtime`, `react-dom/client`, …) from browser plugin
 * bundles. The regex form is deliberately broad: it catches every `react*` /
 * `react-dom*` subpath so none is accidentally bundled (a second React copy
 * triggers `Invalid hook call` at the first render — `external: ["react"]`
 * matches only the literal string and would bundle `react/jsx-runtime`).
 *
 * Paired with the host import map (injected into Daintree's index.html), the
 * stripped imports resolve at load time to Daintree's single `vendor-react`
 * chunk, sharing one React instance across the host and every loaded plugin.
 *
 * Breadth here is safe only because {@link daintreePlugin} also runs a
 * `resolveId` guard that fails the build on any React subpath the host import
 * map does NOT serve (anything outside {@link HOST_IMPORTMAP_SPECIFIERS}) —
 * so an externalized-but-unmapped specifier is caught at build time, not at
 * runtime as an unresolved bare specifier.
 */
export const reactExternals: readonly RegExp[] = [/^react($|\/)/, /^react-dom($|\/)/] as const;

function isReactSpecifier(id: string): boolean {
  return reactExternals.some((re) => re.test(id));
}

function isHostMappedSpecifier(id: string): boolean {
  return (HOST_IMPORTMAP_SPECIFIERS as readonly string[]).includes(id);
}

/**
 * Node built-ins, both bare (`fs`, `process`) and `node:`-prefixed. A node
 * target externalizes these so they resolve to the real runtime modules
 * instead of being replaced with empty browser shims — the shim is exactly why
 * a stdio MCP server built for the client environment crashes at runtime
 * (`process.stdin === undefined`).
 */
const NODE_BUILTIN_EXTERNALS: readonly string[] = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

/** Build target for a plugin entry. `"browser"` (default) is the renderer/panel
 * preset; `"node"` is for stdio MCP servers and other Node entries. */
export type DaintreeBuildTarget = "browser" | "node";

export interface DaintreePluginOptions {
  /**
   * Extra externals to merge with the preset. Useful when a plugin needs to
   * externalize additional host-provided modules (e.g. a future shared
   * component library), or additional Node-resolved modules for a node target.
   */
  readonly externals?: ReadonlyArray<string | RegExp>;
  /**
   * Build target. `"browser"` (default) wires the React externals + host
   * import-map guard for renderer/panel bundles. `"node"` configures a
   * Node-targeting build for stdio MCP servers: Node built-ins are externalized
   * (not browser-shimmed), node resolve conditions are preferred, and React is
   * NOT externalized (node code has no host import map). Use a separate config
   * file for the node entry (e.g. `vite.config.server.ts`) since `vite build`
   * runs one config object at a time.
   */
  readonly target?: DaintreeBuildTarget;
}

/**
 * Vite plugin that wires Daintree's build presets into a plugin's build.
 *
 * Browser usage (renderer/panel) in a plugin's vite.config.ts:
 *
 * ```ts
 * import { daintreePlugin } from "@daintreehq/plugin-vite";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   plugins: [daintreePlugin()],
 *   build: { lib: { entry: "src/panel.tsx", formats: ["es"] } },
 * });
 * ```
 *
 * Node usage (stdio MCP server) in a separate `vite.config.server.ts`:
 *
 * ```ts
 * import { daintreePlugin } from "@daintreehq/plugin-vite";
 * import { defineConfig } from "vite";
 *
 * export default defineConfig({
 *   plugins: [daintreePlugin({ target: "node" })],
 *   build: { lib: { entry: { server: "src/server.ts" }, formats: ["es"] } },
 * });
 * ```
 *
 * The plugin uses the `config` hook (merge semantics) rather than
 * `configResolved` (read-only) so consumer-supplied externals are preserved.
 */
export function daintreePlugin(options: DaintreePluginOptions = {}): Plugin {
  const extras = options.externals ?? [];
  const target = options.target ?? "browser";

  if (target === "node") {
    return {
      name: "daintree-plugin-vite",
      config: () => ({
        resolve: {
          // Prefer Node export conditions and main fields (drop "browser") so
          // dependencies resolve to their Node builds, not browser shims.
          conditions: ["node", "module", "import", "default"],
          mainFields: ["module", "jsnext:main", "jsnext", "main"],
        },
        build: {
          // Modern Node target so esbuild/Rolldown don't down-level or shim
          // built-ins. Daintree spawns the server with the bundled Node.
          target: "node18",
          rollupOptions: {
            external: [...NODE_BUILTIN_EXTERNALS, ...extras],
          },
        },
      }),
    };
  }

  return {
    name: "daintree-plugin-vite",
    config: () => ({
      build: {
        rollupOptions: {
          external: [...reactExternals, ...extras],
        },
      },
    }),
    // Fail the build on any React subpath that is externalized (matched by the
    // regexes above) but is NOT served by the host import map. Without this the
    // bundle builds clean and only fails at load with an unresolved bare
    // specifier (the classic `react-dom/server` trap). Returns `null` for
    // mapped specifiers so the `external` config above still externalizes them,
    // and for non-React ids so normal resolution proceeds.
    resolveId(id) {
      if (isReactSpecifier(id) && !isHostMappedSpecifier(id)) {
        throw new Error(
          `[daintree-plugin-vite] "${id}" is externalized as React but the Daintree host ` +
            `import map does not serve it, so it would fail at runtime as an unresolved bare ` +
            `specifier. Supported specifiers: ${HOST_IMPORTMAP_SPECIFIERS.join(", ")}.`
        );
      }
      return null;
    },
  };
}
