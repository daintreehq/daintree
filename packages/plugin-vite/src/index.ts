import { builtinModules } from "node:module";
import type { Plugin } from "vite";

/**
 * The exact React specifiers the Daintree host import map serves. This is the
 * single source of truth for the host/plugin contract: `vite.config.ts` imports
 * this list to emit one facade chunk per specifier and to build the `<script
 * type="importmap">` it injects, and the plugin build (below) errors at build
 * time on any React subpath outside it. Keeping the two sides on one constant is
 * what stops the "externalized but unresolved at runtime" drift (e.g.
 * `react-dom/server`) that this list previously had to be hand-synced against.
 *
 * Adding an entry here is a real change on the host side: it must also declare
 * the specifier's expected public exports in `HOST_REACT_REQUIRED_EXPORTS`
 * (vite.config.ts), which is typed against this list and will fail typecheck
 * until it does.
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
 * stripped imports resolve at load time to a per-specifier facade module that
 * re-exports that specifier's public API. All the facades are backed by
 * Daintree's single `vendor-react` chunk, so the host and every loaded plugin
 * share one React instance. The map deliberately does NOT point at that chunk
 * directly: a code-split chunk only exports the private cross-chunk interface
 * other chunks import from it, so `import { useState } from "react"` failed to
 * load in every packaged build until #11208.
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

/**
 * Vite plugin names that mean the build is running Tailwind itself, and CSS
 * at-rules that mean a stylesheet is.
 *
 * Daintree compiles a plugin's Tailwind classes at runtime, against the running
 * host's Tailwind and the running host's theme. A plugin that ALSO compiles
 * Tailwind ships a second, independently-versioned copy of the same utilities:
 * duplicate rules across two sheets, where document order replaces Tailwind's
 * own utility ordering (`p-4` is meant to sort before `px-3`, and which sheet
 * each came from would decide it instead). Preflight from a plugin sheet would
 * restyle the host outright.
 *
 * Failing the build is the only place this is catchable. At runtime it looks
 * like a plugin that is mostly styled, which is precisely the failure mode the
 * runtime contract exists to remove.
 */
function isTailwindPluginName(name: string): boolean {
  // `@tailwindcss/vite` does not register a plugin under its own package name —
  // it contributes `@tailwindcss/vite:scan`, `@tailwindcss/vite:generate:serve`
  // and `@tailwindcss/vite:generate:build`. An equality check against the
  // package name matches none of them and silently never fires.
  return name === "tailwindcss" || name.startsWith("@tailwindcss/vite");
}

/** Tailwind's `@tailwind` layer names, in v4 and v3 spelling. */
const TAILWIND_LAYERS = new Set(["base", "components", "utilities", "screens", "variants"]);

/** Stylesheet languages whose `//` runs to end of line. Plain CSS has no such form. */
const LINE_COMMENT_EXTENSIONS = /\.(?:scss|sass|less|styl|stylus)(?:\?|$)/;

/**
 * The Tailwind entry directive this stylesheet compiles, or `null`.
 *
 * A real scanner rather than regexes over blanked text, because blanking is not
 * lexical and fails in BOTH directions — each of these is a case a regex pass
 * got wrong:
 *
 *   - `.a{content:"/*"} @tailwind utilities; .b{content:"*\/"}` — the quoted
 *     fragments are not a comment, but a comment regex reads them as one and
 *     erases the real directive between them. Tailwind compiles that file.
 *   - `.a::after { content: '@import "tailwindcss"' }` — an at-rule inside a
 *     string is text, and refusing the build over it is an accusation the
 *     author cannot act on.
 *   - `// Remove @tailwind utilities;` in a `.scss` file — a line comment, which
 *     a CSS-only comment regex does not recognise at all.
 *
 * Walking the source keeps strings and comments out of consideration by
 * construction, so only an at-rule the compiler would actually see is reported.
 */
function findTailwindEntry(code: string, id: string): string | null {
  const lineComments = LINE_COMMENT_EXTENSIONS.test(id);
  let index = 0;

  while (index < code.length) {
    const char = code[index];

    if (char === "/" && code[index + 1] === "*") {
      const end = code.indexOf("*/", index + 2);
      index = end === -1 ? code.length : end + 2;
      continue;
    }
    if (lineComments && char === "/" && code[index + 1] === "/") {
      const end = code.indexOf("\n", index + 2);
      index = end === -1 ? code.length : end + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipCssString(code, index);
      continue;
    }
    if (char === "@") {
      const rule = /^@([a-zA-Z-]+)([^;{]*)/.exec(code.slice(index));
      if (rule) {
        const [matched, name, params] = rule as unknown as [string, string, string];
        if (name === "import" && /^\s*["']tailwindcss["'/]/.test(params)) {
          return '@import "tailwindcss"';
        }
        // No trailing `;` required: Tailwind accepts `@tailwind utilities` at
        // end of file, so demanding the semicolon left a bypass open.
        const layer = /^\s+([a-zA-Z-]+)\s*$/.exec(params)?.[1];
        if (name === "tailwind" && layer && TAILWIND_LAYERS.has(layer)) {
          return `@tailwind ${layer}`;
        }
        index += matched.length;
        continue;
      }
    }
    index++;
  }
  return null;
}

/** Index just past the closing quote of the CSS string opening at `openIndex`. */
function skipCssString(code: string, openIndex: number): number {
  const quote = code[openIndex];
  let index = openIndex + 1;
  while (index < code.length) {
    const char = code[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    // A CSS string cannot span a raw newline; stopping here keeps an
    // unterminated quote from swallowing the rest of the file.
    if (char === "\n") return index;
    index++;
  }
  return index;
}

const CONTRACT_POINTER =
  "Daintree compiles the Tailwind classes your view uses at runtime, against the host's own " +
  "theme, so a plugin must not build its own Tailwind CSS — see docs/plugins/views.md. Use " +
  "utility classes in your markup; ship any plain CSS you still need as root-scoped rules in " +
  "`@layer components`. `@apply` is not part of the plugin contract.";

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
    // `configResolved` rather than `config`: the plugin array is only complete
    // once Vite has merged every source of configuration, so this is the first
    // point at which "is Tailwind wired into this build" has a true answer.
    configResolved(resolved) {
      const offender = resolved.plugins.find((plugin) => isTailwindPluginName(plugin.name));
      if (offender) {
        throw new Error(
          `[daintree-plugin-vite] this build wires the "${offender.name}" Vite plugin. ` +
            CONTRACT_POINTER
        );
      }
    },
    // Catches the other half: a stylesheet pulling Tailwind in directly, which
    // no plugin entry in the config would reveal — `@tailwindcss/postcss`, say,
    // which runs inside Vite's CSS compilation and never appears in the plugin
    // list at all.
    //
    // `order: "pre"` is required, not tidiness. Tailwind's own plugins declare
    // `enforce: "pre"`, and Vite's core `vite:css` runs ahead of normal user
    // plugins, so a plain transform would be handed CSS with the directive
    // already compiled away and would wave the build through.
    transform: {
      order: "pre",
      handler(code, id) {
        if (!/\.(?:css|pcss|postcss|scss|sass|less|styl|stylus)(?:\?|$)/.test(id)) return null;
        const directive = findTailwindEntry(code, id);
        if (directive) {
          throw new Error(
            `[daintree-plugin-vite] ${id} compiles Tailwind itself ` +
              `(found \`${directive}\`). ` +
              CONTRACT_POINTER
          );
        }
        return null;
      },
    },
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
