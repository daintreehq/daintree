import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";
import path from "path";
import { getDevServerConfig } from "./shared/config/devServer";
// Inlines the stylesheets the renderer's plugin Tailwind compiler compiles
// against. Shared with vitest.config.ts so the adapter's contract tests see the
// same bytes the app does — a plain `?raw` import would not, because Vitest
// stubs every `.css` specifier (including `?raw`) to an empty string.
import { pluginStyleContract } from "./scripts/lib/plugin-style-contract.mjs";
import { asciiOnlyChunksPlugin } from "./scripts/lib/ascii-only-chunks.mjs";
import {
  createImportMapState,
  cspTransformPlugin,
  inlineSkeletonScriptsPlugin,
  renderFanoutProbePlugin,
} from "./scripts/lib/vite-index-html";
import {
  PLUGIN_SDK_REACT_CHUNK_NAME,
  PLUGIN_UI_CHUNK_NAME,
  TOUR_CHUNK_NAME,
  hostFacadePlugin,
  hostImportMapDevPlugin,
  hostImportMapPlugin,
  isPluginSdkReactSourceModule,
  isPluginUiSourceModule,
  isTourSourceModule,
} from "./scripts/lib/vite-host-facade";
import {
  chunkModulesPlugin,
  firstRenderSeedsPlugin,
  reactCompilerReportPlugin,
  rendererBundleSizePlugin,
} from "./scripts/lib/vite-build-diagnostics";
import {
  compileHintsPlugin,
  firstRenderModulePreloadPlugin,
  latin400FontPreloadPlugin,
} from "./scripts/lib/vite-boot-preload";

const devServerConfig = getDevServerConfig();

// Build-time invariant guard: esbuild.minifyIdentifiers must stay false.
// xterm 6.0 ships pre-minified code with a closure in `requestMode` that
// captures a mangled parameter name. If esbuild re-minifies the bundle, it
// renames the parameter but not the closure reference, producing
// `ReferenceError: i is not defined` and crashing the parser silently.
// This guard fails the build if the config is accidentally changed.
function xtermMinifyIdentifiersGuardPlugin(): Plugin {
  return {
    name: "xterm-minify-identifiers-guard",
    apply: "build",
    configResolved(config) {
      const esbuildConfig = config.esbuild;
      if (!esbuildConfig || esbuildConfig.minifyIdentifiers !== false) {
        throw new Error(
          "esbuild.minifyIdentifiers must be false to prevent xterm 6.0 parser crash. " +
            "See https://github.com/daintreehq/daintree/blob/develop/vite.config.ts#L215-L221"
        );
      }
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const { logger: compilerLogger, plugin: compilerReportPlugin } =
    reactCompilerReportPlugin(command);
  const importMapState = createImportMapState();
  return {
    envPrefix: ["VITE_", "DAINTREE_"],
    // Every platform's renderer carries the Remote Hosts Shell (Windows drives
    // WSL distros); the Host role is gated in main at runtime and build time.
    define: {
      __DAINTREE_REMOTE_HOSTS__: JSON.stringify(true),
    },
    // xterm 6.0 ships a bundled InputHandler that references an unminified
    // identifier in `requestMode`; Vite's default identifier mangling produces
    // `ReferenceError: i is not defined` at runtime. Disable identifier
    // renaming only — whitespace and syntax compression still apply.
    esbuild: {
      minifyIdentifiers: false,
    },
    plugins: [
      pluginStyleContract(),
      react(),
      babel({
        // node_modules is the plugin's default. The SDK's React hooks (served to
        // raw views through the import map) ship uncompiled from tsup, so the
        // host serves them uncompiled too — the same code a bundled view runs.
        exclude: [/[/\\]node_modules[/\\]/, /[/\\]packages[/\\]plugin-sdk[/\\]src[/\\]/],
        presets: [
          reactCompilerPreset({
            compilationMode: "infer",
            // panicThreshold gates whether the build itself crashes. In dev we
            // want loud failures on syntax-level violations; in build we never
            // want the renderer build to crash because of a compiler hiccup —
            // the logger + budget script are the regression signal instead.
            panicThreshold: command === "build" ? "none" : "critical_errors",
            logger: compilerLogger,
            // target: "19" emits imports from `react/compiler-runtime` (shipped
            // with React 19) instead of the `react-compiler-runtime` polyfill,
            // dropping the polyfill out of the bundle.
            target: "19",
          }),
        ],
      }),
      tailwindcss(),
      // Must precede hostImportMapPlugin: it emits (and validates) the facade
      // chunks that plugin's transformIndexHtml resolves the map targets from.
      hostFacadePlugin(),
      hostImportMapPlugin(importMapState),
      hostImportMapDevPlugin(),
      // Must precede cspTransformPlugin: both use default-order
      // transformIndexHtml hooks (registration order), and the CSP transform
      // reads the skeleton hashes this plugin stores in shared state.
      inlineSkeletonScriptsPlugin(importMapState),
      // Bench-only (no-op unless DAINTREE_RENDER_PROBE=1). Must sit between
      // inlineSkeletonScriptsPlugin (buildStart resets the hash list) and
      // cspTransformPlugin (reads it) — all three use default-order
      // transformIndexHtml hooks, so registration order is execution order.
      renderFanoutProbePlugin(importMapState),
      cspTransformPlugin(importMapState),
      compilerReportPlugin,
      rendererBundleSizePlugin(),
      firstRenderSeedsPlugin(),
      latin400FontPreloadPlugin(),
      firstRenderModulePreloadPlugin(),
      chunkModulesPlugin(),
      // Before compileHintsPlugin: both are post-order generateBundle hooks, and
      // the re-print would drop the line-1 compile hint it prepends.
      asciiOnlyChunksPlugin(),
      compileHintsPlugin(),
      xtermMinifyIdentifiersGuardPlugin(),
      ...(process.env.ANALYZE === "true"
        ? [visualizer({ filename: "stats.html", gzipSize: true, brotliSize: true }) as Plugin]
        : []),
    ],
    base: "./",
    build: {
      target: "chrome148",
      // Bench builds skip minification so the render-fanout probe reports
      // readable component names (only explicit displayNames survive the
      // minifier). Never set for shipped builds.
      ...(process.env.DAINTREE_RENDER_PROBE === "1" ? { minify: false } : {}),
      modulePreload: { polyfill: false },
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
      // Emits dist/.vite/manifest.json with chunk graph metadata (imports[]
      // for sync deps, dynamicImports[] for React.lazy / dynamic import()).
      // Consumed by scripts/check-first-render-chunk-budget.mjs to bound the
      // gzip closure of chunks reachable from the first-render path.
      manifest: true,
      rolldownOptions: {
        onLog(level, log, defaultHandler) {
          if (log.code === "INEFFECTIVE_DYNAMIC_IMPORT" || log.code === "PLUGIN_TIMINGS") return;
          defaultHandler(level, log);
        },
        ...(mode === "production" && {
          treeshake: {
            manualPureFunctions: ["console.log", "console.info", "console.warn", "console.debug"],
          },
        }),
        experimental: {
          lazyBarrel: true,
        },
        output: {
          // The `boot` codeSplitting group merges cross-chunk module sets,
          // which can reorder module evaluation relative to the automatic
          // chunking the app's latent import cycles happened to tolerate.
          // strictExecutionOrder makes rolldown preserve the exact
          // topological evaluation order across chunk boundaries.
          strictExecutionOrder: true,
          codeSplitting: {
            groups: [
              {
                // Top priority on purpose: this must exceed every group whose
                // captured packages depend on React, because rolldown
                // advancedChunks groups capture their modules' dependency
                // closure unless a higher-priority group claims them first. At
                // priority 15, react/index.js + react/jsx-runtime.js were
                // captured into vendor-editor (priority 60), dragging the whole
                // CodeMirror runtime into the entry's eager static closure.
                // Any future group added above 80 must not match React-dependent
                // packages, or react core leaks back into that group's chunk.
                name: "vendor-react",
                test: /node_modules[\\/](react|react-dom|scheduler|use-sync-external-store)[\\/]/,
                priority: 80,
              },
              {
                name: "vendor-xterm-webgl",
                test: /node_modules[\\/]@xterm[\\/]addon-webgl[\\/]/,
                priority: 75,
              },
              {
                // Keep the dynamically imported addons outside the eager xterm
                // vendor chunk. A broad @xterm rule used to collapse those
                // import boundaries, making every project view parse image,
                // search, and Unicode addon code at startup.
                name: "vendor-xterm",
                test: /node_modules[\\/]@xterm[\\/](?!addon-(?:image|search|unicode11)[\\/])/,
                priority: 74,
              },
              {
                name: "vendor-xterm-image",
                test: /node_modules[\\/]@xterm[\\/]addon-image[\\/]/,
                priority: 73,
              },
              {
                name: "vendor-xterm-search",
                test: /node_modules[\\/]@xterm[\\/]addon-search[\\/]/,
                priority: 73,
              },
              {
                name: "vendor-xterm-unicode11",
                test: /node_modules[\\/]@xterm[\\/]addon-unicode11[\\/]/,
                priority: 73,
              },
              {
                // Excludes @codemirror/lang-* and @codemirror/legacy-modes so
                // those per-language parsers split into their own async chunks
                // instead of being forced into the eager vendor-editor closure.
                name: "vendor-editor",
                test: /node_modules[\\/](@codemirror[\\/](?!lang-|legacy-modes)|@uiw[\\/]|refractor[\\/](?!lang[\\/]))/,
                priority: 60,
              },
              {
                // `entriesAware: true` makes Rolldown split this group by the
                // set of entries that import each module rather than merging
                // everything into one chunk. The eager motion runtime
                // (LazyMotion, MotionConfig, `m`) is imported by the renderer
                // entry and stays eager; the heavy `domMax` feature subtree is
                // reachable only through the dynamic import("./lib/motionFeatures")
                // boundary, so it lands in its own deferred subgroup chunk off
                // the first-paint path — preserving the LazyMotion deferral
                // instead of sweeping ~43KB gzip into the eager closure (#8821).
                // A plain `$initial` tag is insufficient: it evicts domMax from
                // this group, but the orphaned modules then fall into the eager
                // catch-all `vendor` chunk. `entriesAwareMergeThreshold: 0`
                // disables small-subgroup merging so the deferred split holds.
                //
                // vite is held at ~8.0.14 (package.json): 8.1.x (rolldown
                // ~1.1.5) re-materializes this split but miscompiles it — the
                // motionFeatures facade chunk re-exports the deferred
                // subgroup's `domMax` binding without ever invoking that
                // chunk's lazy-init function, so LazyMotion's features resolve
                // to undefined and renderer boot dies with "Cannot destructure
                // property 'renderer' of 'undefined'". Note the split is
                // already inert on 8.0.x/rolldown 1.0.x (domMax currently
                // merges into the eager vendor-motion chunk); verify both the
                // init wiring and the restored deferral before lifting the
                // pin.
                name: "vendor-motion",
                test: /node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/,
                entriesAware: true,
                entriesAwareMergeThreshold: 0,
                priority: 50,
              },
              {
                // The glyphs the app imports by name. The plugin kit reaches
                // every other Lucide icon through lucide-react's dynamic import
                // map, and a module reached only that way (the map, its
                // re-export shim, and each of ~1,600 icons) keeps its own lazy
                // chunk: claimed here, all of it would load at startup. A
                // lucide-react module is static when anything outside the
                // package imports it, or a static lucide-react module does.
                name: (id, ctx) => {
                  const seen = new Set<string>();
                  const isStatic = (moduleId: string): boolean => {
                    if (seen.has(moduleId)) return false;
                    seen.add(moduleId);
                    const info = ctx.getModuleInfo(moduleId);
                    if (!info) return true;
                    if (info.isEntry) return true;
                    return info.importers.some(
                      (importer) =>
                        !/node_modules[\\/]lucide-react[\\/]/.test(importer) || isStatic(importer)
                    );
                  };
                  return isStatic(id) ? "vendor-icons" : null;
                },
                test: /node_modules[\\/]lucide-react[\\/]/,
                priority: 40,
              },
              {
                name: "vendor-ai-github",
                test: /node_modules[\\/](@octokit[\\/]|@ai-sdk[\\/]|ai[\\/])/,
                priority: 30,
              },
              {
                name: "vendor-zod",
                test: /node_modules[\\/](zod[\\/]|zod-to-json-schema[\\/])/,
                priority: 20,
              },
              {
                // Shared Radix utility deps used by both the eager primitives
                // (slot/checkbox/switch) and the deferred overlay primitives.
                // Splitting these out of `vendor-radix-overlay` prevents the
                // eager `vendor-radix` chunk from pulling in the overlay chunk.
                name: "vendor-radix-utils",
                test: /node_modules[\\/]@radix-ui[\\/](primitive|react-compose-refs|react-context|react-presence|react-primitive|react-use-controllable-state|react-use-previous|react-use-size|react-use-callback-ref|react-use-layout-effect|react-use-escape-keydown|react-use-effect-event|react-use-rect|react-id|react-slot)[\\/]/,
                priority: 14,
              },
              {
                // Overlay primitives deferred via gesture-primed dynamic import
                // (see `src/components/ui/radix-deferred.ts`). Matches the 5
                // wrapper primitives plus their unique transitive deps. Shared
                // utility deps live in `vendor-radix-utils` so the eager
                // slot/checkbox/switch path doesn't have to wait for the
                // deferred chunk.
                name: "vendor-radix-overlay",
                test: /node_modules[\\/]@radix-ui[\\/](react-tooltip|react-popover|react-dropdown-menu|react-select|react-context-menu|react-menu|react-popper|react-arrow|react-collection|react-roving-focus|react-focus-scope|react-focus-guards|react-dismissable-layer|react-portal|react-visually-hidden|react-direction)[\\/]/,
                priority: 13,
              },
              {
                name: "vendor-radix",
                test: /node_modules[\\/]@radix-ui[\\/]/,
                priority: 12,
              },
              {
                // Exclude `refractor/lang/*`, `@codemirror/lang-*`,
                // `@codemirror/legacy-modes`, and the per-grammar `@lezer/*`
                // parser packages so each per-language parser (and its
                // grammar dependency) stays in its own async chunk instead
                // of being swept into this catch-all (which is part of the
                // eager closure). `@lezer/common` and `@lezer/highlight` are
                // allowed here as @codemirror/language deps (in practice the
                // vendor-editor closure capture claims them). `@lezer/lr` is
                // deliberately NOT allowed: its only importers are the lazy
                // per-language parser chunks, and pinning it into this eager
                // chunk made `vendor` statically import vendor-editor (via
                // @lezer/lr -> @lezer/common), dragging CodeMirror back into
                // the entry's eager closure after the vendor-react pin.
                // `entriesAware` + `entriesAwareMergeThreshold: 0` (see
                // vendor-motion above) keep packages reachable only through
                // dynamic imports (react-diff-view, frimousse, react-colorful,
                // …) in deferred subgroup chunks instead of being swept into
                // the eager entry vendor chunk. Both flags are required: the
                // threshold disables small-subgroup re-merging, without which
                // the deferred split silently collapses back into the eager
                // chunk.
                name: "vendor",
                test: /node_modules[\\/](?!(refractor[\\/]lang[\\/]|@codemirror[\\/](lang-|legacy-modes)|@lezer[\\/](?!(common|highlight)[\\/])))/,
                entriesAware: true,
                entriesAwareMergeThreshold: 0,
                priority: 10,
              },
              {
                // The tour engine as one chunk, claimed ahead of `boot`. The
                // tour facades (hostFacadePlugin) are entries that import it
                // statically, which tags it `$initial`; without this group
                // `boot` would sweep it into the eager first-render closure,
                // though only the lazy TourDialog and plugin scenes use it.
                // One chunk is also the single-instance guarantee: host and
                // plugin scenes share one TourPlayerContext. No
                // `entriesAware` — that splits per importing-entry set.
                name: TOUR_CHUNK_NAME,
                test: (id: string) => isTourSourceModule(id),
                priority: 5,
              },
              {
                // Collapse the automatic-chunking tail of the entry's static
                // closure. Modules shared between the entry and dynamic
                // imports otherwise split into per-share-set chunks, leaving
                // the boot-critical closure scattered across dozens of tiny
                // files — each an extra app:// request through the main
                // process's protocol handler during the busiest phase of
                // boot. `$initial` captures only modules statically reachable
                // from an entry (never lazy-only code). The merge trades
                // bytes for requests: strictExecutionOrder wrappers and
                // coarser chunk boundaries grow the eager closure several
                // percent gzip, but the request-count cut wins by a wide
                // margin in perf:launch-ab A/B runs (cold first-interactive
                // ~-25%, warm ~-8%). Lowest priority: every vendor group must
                // claim its node_modules first, leaving app-source modules
                // here. maxSize keeps merged chunks near the size of the
                // existing large chunks so background compile parallelism is
                // preserved.
                name: "boot",
                tags: ["$initial"],
                // Never capture the entry facade or Vite's virtual modules:
                // swallowing src/main.tsx or the index.html proxy demotes the
                // entry chunk (the manifest loses isEntry), which breaks the
                // first-render budget scripts and the modulepreload seed
                // derivation. Virtual modules (\0-prefixed helpers, html
                // proxies) stay wherever automatic chunking puts them.
                // `src/pluginUi` belongs to the `plugin-ui` group below.
                test: (id: string) => {
                  if (id.includes("\0") || id.includes(".html")) return false;
                  if (isPluginUiSourceModule(id)) return false;
                  if (isPluginSdkReactSourceModule(id)) return false;
                  return !id.split(path.sep).join("/").endsWith("src/main.tsx");
                },
                priority: 1,
                maxSize: 400_000,
              },
              {
                // Same reason as `tour`: the plugin-ui facade is an entry, so
                // `src/pluginUi` is `$initial` and `boot` would sweep it into
                // the first-render closure (its test skips it instead). Below
                // `boot` on purpose: a group also captures its modules'
                // dependencies unless a higher-priority group has them, and
                // the lazy `import()` here depends on Vite's preload helper.
                // Ranked above `boot`, this group took the helper and every
                // startup chunk ended up importing it.
                name: PLUGIN_UI_CHUNK_NAME,
                test: (id: string) => isPluginUiSourceModule(id),
                priority: 0,
              },
              {
                // Same shape and reason as `plugin-ui`: the SDK hooks facade
                // is an entry, and `boot` skips these modules so they stay
                // off the first-render path.
                name: PLUGIN_SDK_REACT_CHUNK_NAME,
                test: (id: string) => isPluginSdkReactSourceModule(id),
                priority: 0,
              },
            ],
          },
        },
      },
    },
    resolve: {
      alias: {
        // Bench builds (DAINTREE_RENDER_PROBE=1, see build:bench) swap in the
        // profiling react-dom bundle so the render-fanout probe
        // (src/utils/renderFanoutProbe.ts) gets per-fiber actualDuration.
        // Production semantics are otherwise identical (no StrictMode
        // double-render); never set for shipped builds.
        ...(process.env.DAINTREE_RENDER_PROBE === "1"
          ? { "react-dom/client": "react-dom/profiling" }
          : {}),
        "@": path.resolve(__dirname, "./src"),
        "@shared": path.resolve(__dirname, "./shared"),
        // The app compiles the tour engine from source, so an edit shows up
        // without rebuilding the package's `dist/` (which only exists for
        // publishing). Subpaths first so the root entry alias doesn't swallow them.
        "@daintreehq/tour/react": path.resolve(__dirname, "./packages/tour/src/react.ts"),
        "@daintreehq/tour/kit": path.resolve(__dirname, "./packages/tour/src/kit.ts"),
        "@daintreehq/tour/mock-app": path.resolve(__dirname, "./packages/tour/src/mock-app.ts"),
        "@daintreehq/tour": path.resolve(__dirname, "./packages/tour/src/index.ts"),
        // Nothing in the app imports this; the host facade does, for plugins.
        "@daintreehq/plugin-ui": path.resolve(__dirname, "./src/pluginUi/index.ts"),
        // Likewise only the raw-view facade imports this. Source, not the
        // package's `dist/`, which is a publish artifact that may be unbuilt.
        "@daintreehq/plugin-sdk/react": path.resolve(
          __dirname,
          "./packages/plugin-sdk/src/react.ts"
        ),
        // refractor/core eagerly imports parse-entities, whose browser-condition
        // decode-named-character-reference touches `document` at module scope —
        // that crashes the diff-tokenize Web Worker at startup. Pin the package's
        // worker-safe default build (character-entities map, no DOM) everywhere.
        "decode-named-character-reference": path.resolve(
          __dirname,
          "node_modules/decode-named-character-reference/index.js"
        ),
      },
    },
    server: {
      host: devServerConfig.host,
      port: devServerConfig.port,
      strictPort: true,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
    },
  };
});
