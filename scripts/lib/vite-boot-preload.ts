import type { Plugin, HtmlTagDescriptor } from "vite";
import path from "path";
import { getFirstRenderPreloadSeeds } from "../../shared/config/panelKindRegistry";
import { computeFirstRenderPreloadFiles } from "../first-render-closure-lib.mjs";
import { isHostFacadeChunkName } from "./vite-host-facade";

// Prepends the V8 explicit-compile-hints magic comment (Chrome >=136; we ship
// Chromium 148) to a curated set of boot-hot chunks so V8 eagerly compiles all
// their functions in one background pass instead of lazily re-parsing each
// function at first call during boot. Curated on purpose, per V8 guidance to
// annotate only files where most functions actually run on load: the entry
// chunk, the App chunk, vendor-react, vendor-xterm, TerminalInstanceService,
// and appThemeStore. vendor-xterm and TerminalInstanceService are no longer
// boot-loaded (they arrive with the first terminal, #14239, #14267), but most
// of both still runs the moment they load: the service's constructor wires
// every controller, and the terminal it was loaded for is created at once. A
// view with no terminal now pays neither the parse nor the compile.
// Everything else — explicitly including vendor-editor (~451KB of CodeMirror
// that is mostly uncalled at boot) and palette/settings/per-language chunks —
// is excluded to avoid wasted background compile and bytecode memory.
//
// Measured in #14238 (docs/performance/2026-10-23-boot-compile-hints.md): the
// set costs ~5.8 MiB of compiled code per idle project view; dropping it made
// new project views reveal ~70 ms later and warm launches ~40 ms later (median).
// Most of the new-view gain rides on the App hint, so cut App's never-called
// code rather than its hint.
//
// Must run in generateBundle (NOT renderChunk, NOT the `banner` option):
// rolldown's native oxc minifier runs after renderChunk and would strip or
// displace the comment, and V8 only honors it on line 1. generateBundle runs
// post-minify, so the comment lands as the first line of the emitted file.
//
// The raw prepend is sourcemap-unsafe (it shifts every line by one without
// adjusting mappings). Acceptable here because production maps are not
// shipped — build.sourcemap is false in vite.config.ts. If sourcemaps are ever
// enabled, this must move to a magic-string-based edit that remaps.
export function compileHintsPlugin(): Plugin {
  const COMPILE_HINT = "//# allFunctionsCalledOnLoad\n";
  // Stable codeSplitting group / facade-derived chunk names.
  const hintedChunkNames = new Set([
    "vendor-react",
    "vendor-xterm",
    "TerminalInstanceService",
    "appThemeStore",
  ]);
  // The `boot` codeSplitting group holds the entry's static closure (the
  // modules that previously lived inline in the hinted entry chunk); maxSize
  // may split it into boot, boot2, ... — hint every split.
  const isBootGroupChunk = (name: string): boolean => /^boot\d*$/.test(name);
  // Fallback for chunks whose name could drift: match the facade module.
  const hintedFacadeSuffixes = [
    "src/App.tsx",
    "src/services/TerminalInstanceService.ts",
    "src/store/appThemeStore.ts",
  ];

  // A/B lever for re-measuring the trade-off above, never set in a shipped
  // build: `none` drops every hint, `no-vendor` drops vendor-react and
  // vendor-xterm, `no-app` drops the App chunk.
  const hintMode = process.env.DAINTREE_COMPILE_HINTS ?? "all";
  if (!["all", "no-vendor", "no-app", "none"].includes(hintMode)) {
    throw new Error(
      `DAINTREE_COMPILE_HINTS must be all, no-vendor, no-app or none (got "${hintMode}")`
    );
  }

  const isHinted = (chunk: {
    isEntry: boolean;
    name: string;
    facadeModuleId?: string | null;
  }): boolean => {
    if (hintMode === "none") return false;
    if (hintMode === "no-vendor" && chunk.name.startsWith("vendor-")) return false;
    const facade = chunk.facadeModuleId?.split(path.sep).join("/");
    if (hintMode === "no-app" && facade?.endsWith("src/App.tsx")) return false;
    // The host facades are entries but not boot-hot: they're re-export shims a
    // plugin pulls in on demand, so eager-compiling them costs startup time for
    // code the app itself never calls.
    if (isHostFacadeChunkName(chunk.name)) return false;
    return (
      chunk.isEntry ||
      hintedChunkNames.has(chunk.name) ||
      isBootGroupChunk(chunk.name) ||
      (facade != null && hintedFacadeSuffixes.some((suffix) => facade.endsWith(suffix)))
    );
  };

  return {
    name: "v8-compile-hints",
    apply: "build",
    // generateBundle mutations happen after [hash] placeholders are resolved,
    // so the prepended hint would not by itself change a chunk's filename.
    // Folding the hint into the hash here keeps hinted-set/comment changes
    // cache-correct for any consumer keyed on the chunk URL.
    augmentChunkHash(chunk) {
      return isHinted(chunk) ? COMPILE_HINT : undefined;
    },
    // `order: "post"` is required: vite:build-import-analysis also mutates
    // chunk code in generateBundle (prepending the `__vite__mapDeps` const to
    // chunks with dynamic imports), and it runs after default-order hooks. A
    // default-order hook here left the hint on line 2 for the entry/App/
    // TerminalInstanceService chunks, where V8 ignores it.
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          if (isHinted(output) && !output.code.startsWith(COMPILE_HINT)) {
            output.code = COMPILE_HINT + output.code;
          }
        }
      },
    },
  };
}

// Minimal view of a Rolldown OutputChunk passed to the preload helper. The
// bundle's `imports[]` / `dynamicImports[]` hold output FILE NAMES (other bundle
// keys), not the source-path keys the manifest uses — these are JS getters on
// the native handle, so they're read lazily, never structured-cloned.
interface BundleChunkLike {
  type: string;
  name?: string;
  fileName: string;
  isEntry?: boolean;
  facadeModuleId?: string | null;
  imports?: string[];
  dynamicImports?: string[];
}

// Injects `<link rel="modulepreload">` for the eager static closure of the
// first-render seed chunks (the app root the entry shell dynamically imports).
// Vite auto-preloads the entry chunk and everything in its static `imports[]`
// closure, but NOT chunks reached only through a dynamic import() boundary — so
// App and its private vendor deps would download serially (parse entry →
// discover the lazy import → fetch the chunk → discover its deps → fetch
// those). Preloading the eager closure of the seeds collapses that waterfall.
// Restored-pane chunks are session-dependent and warmed by the entry shell from
// the boot payload instead (preloadRestoredPanes), so a session without a
// file/diff pane never pays for CodeMirror here.
//
// Eager-only by construction: the closure follows `imports[]` and NEVER
// `dynamicImports[]`, so deliberately-deferred subtrees (vendor-motion's domMax,
// #8821) are not pulled onto the first-paint path. The set-building logic lives
// in computeFirstRenderPreloadFiles (scripts/first-render-closure-lib.mjs),
// which shares the exact `followDynamic: false` traversal the first-render-chunk
// budget gates on, so the injected preload set and the measured budget cannot
// drift. Chunk membership is untouched — this only adds <link> tags to the HTML.
export function firstRenderModulePreloadPlugin(): Plugin {
  // getFirstRenderPreloadSeeds() returns repo-relative POSIX source paths; the
  // bundle keys chunks by hashed file name and tags each lazy seed chunk with an
  // absolute `facadeModuleId`, so seeds are matched by normalizing each
  // facadeModuleId back to that same repo-relative POSIX form.
  const seedSourcePaths = new Set(getFirstRenderPreloadSeeds());
  const root = process.cwd();
  const toRelativePosix = (facadeModuleId: string) =>
    path.relative(root, facadeModuleId).split(path.sep).join("/");

  return {
    name: "first-render-modulepreload",
    apply: "build",
    // Default-order transformIndexHtml: runs AFTER bundling so `ctx.bundle` is
    // populated (`order: "pre"` would see `ctx.bundle === undefined`). Emits
    // only <link> tags, which don't participate in the CSP `script-src` hash, so
    // ordering relative to host-import-map / csp-transform is irrelevant.
    transformIndexHtml(_html, ctx) {
      // Populated only for production builds — the dev server has no bundle.
      if (!ctx.bundle) return;

      // Drop the host facades before the closure math. computeFirstRenderPreloadFiles
      // subtracts every `isEntry` chunk's closure as "what Vite already
      // auto-preloads" — true for the HTML entry, false for the facades, which
      // index.html never references (a plugin imports them at runtime through
      // the import map). Leaving them in would subtract a closure the browser
      // was never given, silently dropping preload tags a first-render seed needs.
      const chunks = Object.values(ctx.bundle as unknown as Record<string, BundleChunkLike>).filter(
        (chunk) => !isHostFacadeChunkName(chunk.name ?? "")
      );
      const { files, matchedSeedCount } = computeFirstRenderPreloadFiles(
        chunks,
        seedSourcePaths,
        toRelativePosix
      );

      if (matchedSeedCount === 0) {
        // No seed chunk matched a registry source path — most likely a panel
        // chunk was merged into a facade-less shared chunk by a future refactor.
        // Warn and emit nothing rather than failing the build; the budget gate
        // still measures the closure independently and would catch real drift.
        console.warn(
          "[first-render-modulepreload] no first-render seed chunk matched getFirstRenderPreloadSeeds() — emitting no preload tags"
        );
        return;
      }

      if (matchedSeedCount < seedSourcePaths.size) {
        // Some — but not all — seeds resolved. Partial coverage is otherwise
        // silent (the zero-match guard above doesn't fire), so the preload set
        // would quietly miss a panel's closure. Surface it; the budget gate
        // measures the manifest closure separately and can't catch this.
        console.warn(
          `[first-render-modulepreload] only ${matchedSeedCount} of ${seedSourcePaths.size} first-render seeds matched a chunk facadeModuleId — preload coverage is incomplete`
        );
      }

      // `base` is "./" (relative — required by the Electron app:// protocol) and
      // Vite emits asset hrefs as base + fileName; match that exactly. The
      // `crossorigin` boolean attr mirrors Vite's own modulepreload links so the
      // preload matches the subsequent CORS module fetch instead of double-loading.
      return files.map((fileName): HtmlTagDescriptor => ({
        tag: "link",
        attrs: { rel: "modulepreload", crossorigin: true, href: `./${fileName}` },
        injectTo: "head",
      }));
    },
  };
}

export function latin400FontPreloadPlugin(): Plugin {
  return {
    name: "latin-400-font-preload",
    apply: "build",
    transformIndexHtml(_html, ctx) {
      if (!ctx.bundle) return;

      for (const output of Object.values(ctx.bundle)) {
        if (
          output.type === "asset" &&
          typeof output.fileName === "string" &&
          /jetbrains-mono-latin-400-normal.*\.woff2$/.test(output.fileName)
        ) {
          return [
            {
              tag: "link",
              attrs: {
                rel: "preload",
                as: "font",
                type: "font/woff2",
                crossorigin: "anonymous",
                href: `./${output.fileName}`,
              },
              injectTo: "head-prepend",
            },
          ];
        }
      }

      console.warn(
        "[latin-400-font-preload] jetbrains-mono-latin-400-normal woff2 asset not found"
      );
    },
  };
}
