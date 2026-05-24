import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { LintRules } from "babel-plugin-react-compiler";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";
import path from "path";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { getDevServerConfig } from "./shared/config/devServer";
import { getDaintreeAppDevCSP, getDaintreeAppProdCSP } from "./shared/config/csp";
import { getFirstRenderSeeds } from "./shared/config/panelKindRegistry";

const devServerConfig = getDevServerConfig();

// CSP definitions for development and production. Single source of truth lives
// in shared/config/csp.ts so the meta tag injected here and the HTTP header set
// by the main process stay in sync — the browser intersects header + meta, so
// any divergence silently tightens the effective policy and breaks the app.
const DEV_CSP = getDaintreeAppDevCSP();
const PROD_CSP = getDaintreeAppProdCSP();

// Severity bucketing derived from the live plugin's LintRules registry rather
// than hard-coded, so a plugin upgrade that recategorizes a rule reflows the
// gate automatically. As of babel-plugin-react-compiler 1.0.0: 1 Hint (Todo),
// 2 Warning (IncompatibleLibrary, UnsupportedSyntax), 23 Error categories.
const SEVERITY_BY_CATEGORY: Record<string, string> = Object.fromEntries(
  LintRules.map((rule) => [rule.category, rule.severity])
);

// Look up a category's severity WITHOUT touching detail.severity — that getter
// throws ("Unsupported category X") for any ErrorCategory not in the plugin's
// internal switch, which would crash the build the first time a future plugin
// version emits a new category. Unknown categories default to "Error" so they
// land in the strict gate (fail loud) rather than the silent Hint count.
function severityForCategory(category: string): string {
  return SEVERITY_BY_CATEGORY[category] ?? "Error";
}

// Per-file accumulator written to dist/compiler-bailout-report.json after the
// build completes. Counts come from babel-plugin-react-compiler's logger:
// CompileSuccess, CompileSkip, CompileError, PipelineError. Other event kinds
// (Timing, CompileDiagnostic, AutoDeps*) are ignored — they aren't regression
// signals. CompileError events are bucketed by severity: Hint-severity bailouts
// (the cosmetic "Todo" try/catch-lowering noise that dominates the report)
// collapse to a single `hintCount`, while Error+Warning bailouts are tracked
// verbatim in `errorBailouts` so the strict gate can point at the actual cause
// without rebuilding locally. The accumulator Map and the logger object MUST be
// created in the same factory call so they share state via closure; threading
// either through module scope would silently produce an empty report.
type CompilerBailoutEntry = {
  success: number;
  skip: number;
  error: number;
  pipeline: number;
  // Hint-severity CompileError count (cosmetic "Todo" bailouts). Collapsed to a
  // number so a shifting count produces a one-line diff instead of N lines of
  // repeated reason-string churn.
  hintCount: number;
  // Error+Warning-severity bailouts only — Hint entries are counted in
  // hintCount, not pushed here. Source type is `ErrorCategory` from
  // babel-plugin-react-compiler — kept as string at this boundary to avoid
  // cross-package type coupling that would break silently on a plugin upgrade.
  errorBailouts: Array<{ category: string; severity: string; reason: string }>;
  skipReasons: string[];
  pipelineErrors: string[];
};

type CompilerLoggerEvent =
  | { kind: "CompileSuccess" }
  | { kind: "CompileSkip"; reason?: unknown }
  | { kind: "CompileError"; detail?: unknown }
  | { kind: "PipelineError"; data?: unknown }
  | { kind: string };

type CompilerLogger = {
  logEvent: (filename: string | null, event: CompilerLoggerEvent) => void;
};

// PipelineError.data is a serialized stack trace. Keep only the first line
// (the error message) and cap length so a pathological single-line error
// can't bloat the report.
function summarizePipelineError(data: unknown): string {
  return String(data ?? "")
    .split(/\r?\n/)[0]
    .slice(0, 200);
}

function reactCompilerReportPlugin(command: "build" | "serve"): {
  plugin: Plugin;
  logger: CompilerLogger;
} {
  const counts = new Map<string, CompilerBailoutEntry>();
  const cwd = process.cwd();
  const reportPath = path.join(cwd, "dist", "compiler-bailout-report.json");

  function getOrInit(filename: string): CompilerBailoutEntry {
    let entry = counts.get(filename);
    if (!entry) {
      entry = {
        success: 0,
        skip: 0,
        error: 0,
        pipeline: 0,
        hintCount: 0,
        errorBailouts: [],
        skipReasons: [],
        pipelineErrors: [],
      };
      counts.set(filename, entry);
    }
    return entry;
  }

  const logger: CompilerLogger = {
    logEvent(filename, event) {
      // Skip in dev — the closeBundle flush is gated to build mode (the
      // plugin has apply:"build"), so accumulating in serve would just leak.
      if (command !== "build") return;
      if (!filename) return;
      // Normalize to repo-relative POSIX path so report keys match across
      // operating systems and don't leak absolute filesystem paths.
      const rel = path.relative(cwd, filename).split(path.sep).join("/");
      if (!rel || rel.startsWith("..")) return;
      const entry = getOrInit(rel);
      switch (event.kind) {
        case "CompileSuccess":
          entry.success++;
          break;
        case "CompileSkip": {
          entry.skip++;
          const reason = (event as { reason?: unknown }).reason;
          if (typeof reason === "string" && reason.length > 0) {
            entry.skipReasons.push(reason);
          }
          break;
        }
        case "CompileError": {
          // Raw event count, kept for diagnostics — it is NOT a gate key (the
          // strict gate counts errorBailouts; Hints gate via hintCount).
          entry.error++;
          // detail is CompilerErrorDetail | CompilerDiagnostic — both expose
          // .category (ErrorCategory enum) and .reason (string) via getters
          // backed by required Zod-validated options. Cast is safe. We resolve
          // severity from the category via the prebuilt map rather than the
          // detail.severity getter, which throws on unknown categories.
          const detail = (event as { detail?: { category?: unknown; reason?: unknown } }).detail;
          if (detail && typeof detail === "object") {
            const category = String(detail.category ?? "");
            const severity = severityForCategory(category);
            if (severity === "Hint") {
              // Cosmetic Todo-style bailout — collapse to a count, don't store
              // the verbose reason string.
              entry.hintCount++;
            } else {
              entry.errorBailouts.push({
                category,
                severity,
                reason:
                  typeof detail.reason === "string" ? detail.reason : String(detail.reason ?? ""),
              });
            }
          }
          break;
        }
        case "PipelineError": {
          entry.pipeline++;
          const summary = summarizePipelineError((event as { data?: unknown }).data);
          if (summary.length > 0) entry.pipelineErrors.push(summary);
          break;
        }
        default:
          // Timing, CompileDiagnostic, AutoDepsDecorations, AutoDepsEligible —
          // not regression signals.
          break;
      }
    },
  };

  return {
    logger,
    plugin: {
      name: "react-compiler-report",
      apply: "build",
      buildStart() {
        // Reset between builds — relevant for `vite build --watch` or any
        // scenario that triggers a second build inside the same Node process.
        // Without this, watch-mode rebuilds would inflate every count.
        counts.clear();
      },
      closeBundle() {
        if (command !== "build") return;
        if (counts.size === 0) {
          // Empty accumulator means the logger was never invoked — almost
          // certainly a wiring bug (logger not threaded into reactCompilerPreset
          // or factory called twice and the report plugin captured a stale
          // Map). Failing loud here beats silently passing CI.
          throw new Error(
            "[react-compiler-report] logger received zero events; check that the logger from reactCompilerReportPlugin() is passed into reactCompilerPreset({ logger })."
          );
        }
        // Plain lexicographic sort matches the check script's default Array#sort
        // so the freshly built report and the checked-in baseline diff cleanly.
        const sorted = [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const out: Record<string, CompilerBailoutEntry> = {};
        for (const [file, entry] of sorted) out[file] = entry;
        mkdirSync(path.dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, JSON.stringify(out, null, 2) + "\n");
      },
    },
  };
}

// Plugin to transform CSP meta tag based on build mode
function cspTransformPlugin(): Plugin {
  return {
    name: "csp-transform",
    transformIndexHtml(html, ctx) {
      const csp = ctx.server ? DEV_CSP : PROD_CSP;
      const cspRegex = /<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i;

      if (!cspRegex.test(html)) {
        throw new Error(
          'CSP meta tag not found in index.html. Expected: <meta http-equiv="Content-Security-Policy" ...>'
        );
      }

      return html.replace(
        cspRegex,
        `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
      );
    },
  };
}

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

// Emits dist/renderer-bundle-size-report.json after the build completes with
// per-chunk and total JS/CSS sizes (raw + gzip). Used by the CI bundle size
// budget gate to catch silent regressions from dependency upgrades or
// accidental full-library imports.
function rendererBundleSizePlugin(): Plugin {
  const reportPath = path.join(process.cwd(), "dist", "renderer-bundle-size-report.json");

  return {
    name: "renderer-bundle-size-report",
    apply: "build",
    writeBundle(_options, bundle) {
      const chunks: Record<string, { raw: number; gzip: number }> = {};
      let entryChunkName: string | null = null;
      let totalJsRaw = 0;
      let totalJsGzip = 0;
      let totalCssRaw = 0;
      let totalCssGzip = 0;

      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") {
          const name = output.name || output.fileName;
          const raw = Buffer.byteLength(output.code, "utf8");
          const gz = gzipSync(Buffer.from(output.code, "utf8"), { level: 9 }).byteLength;
          chunks[name] = { raw, gzip: gz };
          totalJsRaw += raw;
          totalJsGzip += gz;
          if (output.isEntry && !entryChunkName) {
            entryChunkName = name;
          }
        } else if (output.type === "asset" && output.fileName.endsWith(".css")) {
          const src = output.source;
          const buf = typeof src === "string" ? Buffer.from(src, "utf8") : Buffer.from(src);
          const raw = buf.byteLength;
          const gz = gzipSync(buf, { level: 9 }).byteLength;
          totalCssRaw += raw;
          totalCssGzip += gz;
        }
      }

      const sortedChunks = Object.keys(chunks)
        .sort()
        .reduce<Record<string, { raw: number; gzip: number }>>((acc, k) => {
          acc[k] = chunks[k];
          return acc;
        }, {});

      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(
        reportPath,
        JSON.stringify(
          {
            entryChunk: entryChunkName,
            chunks: sortedChunks,
            totals: {
              js: { raw: totalJsRaw, gzip: totalJsGzip },
              css: { raw: totalCssRaw, gzip: totalCssGzip },
            },
          },
          null,
          2
        ) + "\n"
      );
    },
  };
}

// Emits dist/.vite/first-render-seeds.json — the root-relative source paths of
// every lazy panel chunk that loads on the first-render path, derived from the
// panel-kind registry (getFirstRenderSeeds). The check-first-render-chunk-budget
// script reads this artifact instead of a hardcoded list, so the seed set can
// never drift from the registry. Build-only; the seeds are static registry data,
// not bundle-derived, so this doesn't inspect the OutputBundle.
function firstRenderSeedsPlugin(): Plugin {
  const seedsPath = path.join(process.cwd(), "dist", ".vite", "first-render-seeds.json");

  return {
    name: "first-render-seeds",
    apply: "build",
    writeBundle() {
      const seeds = getFirstRenderSeeds();
      mkdirSync(path.dirname(seedsPath), { recursive: true });
      writeFileSync(seedsPath, JSON.stringify(seeds, null, 2) + "\n");
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const { logger: compilerLogger, plugin: compilerReportPlugin } =
    reactCompilerReportPlugin(command);
  return {
    envPrefix: ["VITE_", "DAINTREE_"],
    // xterm 6.0 ships a bundled InputHandler that references an unminified
    // identifier in `requestMode`; Vite's default identifier mangling produces
    // `ReferenceError: i is not defined` at runtime. Disable identifier
    // renaming only — whitespace and syntax compression still apply.
    esbuild: {
      minifyIdentifiers: false,
    },
    plugins: [
      react(),
      babel({
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
      cspTransformPlugin(),
      compilerReportPlugin,
      rendererBundleSizePlugin(),
      firstRenderSeedsPlugin(),
      xtermMinifyIdentifiersGuardPlugin(),
      ...(process.env.ANALYZE === "true"
        ? [visualizer({ filename: "stats.html", gzipSize: true, brotliSize: true }) as Plugin]
        : []),
    ],
    base: "./",
    build: {
      target: "chrome146",
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
          codeSplitting: {
            groups: [
              {
                name: "vendor-xterm-webgl",
                test: /node_modules[\\/]@xterm[\\/]addon-webgl[\\/]/,
                priority: 75,
              },
              { name: "vendor-xterm", test: /node_modules[\\/]@xterm[\\/]/, priority: 70 },
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
                name: "vendor-motion",
                test: /node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/,
                entriesAware: true,
                entriesAwareMergeThreshold: 0,
                priority: 50,
              },
              {
                name: "vendor-icons",
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
                name: "vendor-react",
                test: /node_modules[\\/](react|react-dom|scheduler|use-sync-external-store)[\\/]/,
                priority: 15,
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
                // eager closure). `@lezer/common`, `@lezer/lr`, and
                // `@lezer/highlight` stay in this `vendor` group because
                // `@codemirror/language` depends on them eagerly.
                name: "vendor",
                test: /node_modules[\\/](?!(refractor[\\/]lang[\\/]|@codemirror[\\/](lang-|legacy-modes)|@lezer[\\/](?!(common|lr|highlight)[\\/])))/,
                priority: 10,
              },
            ],
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "@shared": path.resolve(__dirname, "./shared"),
        "@github-renderer": path.resolve(__dirname, "./plugins/builtin/github/renderer"),
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
