import { defineConfig, type Plugin, type HtmlTagDescriptor } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { LintRules } from "babel-plugin-react-compiler";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";
import path from "path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { getDevServerConfig } from "./shared/config/devServer";
import { getDaintreeAppDevCSP, getDaintreeAppProdCSP } from "./shared/config/csp";
// Source of truth for the host/plugin React contract. The plugin build
// (@daintreehq/plugin-vite) errors on any React subpath outside this list, and
// here it drives the injected `<script type="importmap">` — one constant keeps
// the two sides from drifting (the `react-dom/server` "externalized but
// unresolved" class of bug). Imported from source (not the built dist) the same
// way this config already imports from `./shared/*`.
import { HOST_IMPORTMAP_SPECIFIERS } from "./packages/plugin-vite/src/index";
import { getFirstRenderPreloadSeeds } from "./shared/config/panelKindRegistry";
import { computeFirstRenderPreloadFiles } from "./scripts/first-render-closure-lib.mjs";

const devServerConfig = getDevServerConfig();

// CSP definitions for development and production. Single source of truth lives
// in shared/config/csp.ts so the meta tag injected here and the HTTP header set
// by the main process stay in sync — the browser intersects header + meta, so
// any divergence silently tightens the effective policy and breaks the app.
const DEV_CSP = getDaintreeAppDevCSP();

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
          } else {
            // Malformed CompileError (absent/non-object detail). The raw
            // entry.error count no longer gates CI, so a silent drop here would
            // be invisible coverage loss. Land it in the strict gate under an
            // unknown category so it fails loud rather than vanishing — most
            // likely an upstream plugin event-shape change.
            entry.errorBailouts.push({
              category: "(unknown)",
              severity: "Error",
              reason: "malformed CompileError event (no detail object)",
            });
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

// Shared state between hostImportMapPlugin and cspTransformPlugin. Both hooks
// use default-order transformIndexHtml; Vite preserves plugin-array order for
// same-order hooks, and the array places hostImportMapPlugin before
// cspTransformPlugin so the hash is set before the CSP meta tag is rewritten.
// (`order: "pre"` would run before bundling and yield `ctx.bundle === undefined`,
// hiding the vendor-react chunk path.) `buildStart` resets the hash so a
// watch-mode rebuild can't reuse stale state from the previous build.
interface ImportMapBuildState {
  scriptSrcHash: string | null;
  /**
   * SHA-256 hashes for the boot-skeleton scripts inlined into index.html by
   * inlineSkeletonScriptsPlugin. Written by that plugin, read by
   * cspTransformPlugin (meta CSP) and hostImportMapPlugin's closeBundle
   * (HTTP-header CSP sidecar) so all three layers stay aligned.
   */
  skeletonScriptHashes: string[];
}

function createImportMapState(): ImportMapBuildState {
  return { scriptSrcHash: null, skeletonScriptHashes: [] };
}

// Plugin to transform CSP meta tag based on build mode. In production it pulls
// the host import-map hash from the shared state so the inline importmap script
// satisfies `script-src` without weakening the policy with `'unsafe-inline'`.
function cspTransformPlugin(state: ImportMapBuildState): Plugin {
  return {
    name: "csp-transform",
    transformIndexHtml(html, ctx) {
      const allHashes = [
        ...(state.scriptSrcHash ? [state.scriptSrcHash] : []),
        ...state.skeletonScriptHashes,
      ];
      const csp = ctx.server
        ? DEV_CSP
        : getDaintreeAppProdCSP(allHashes.length > 0 ? { scriptSrcHashes: allHashes } : undefined);
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

// Inlines the two tiny boot-skeleton scripts into production index.html and
// defers the cosmetic logo animation. skeleton-ready.js fires the
// APP_SKELETON_PARSED IPC that gates win.show(); as an external classic
// script it blocks on an app:// fetch that competes with the modulepreload
// storm for the main process's protocol handler during the busiest phase of
// boot. Inlining removes that fetch from the reveal path entirely.
// skeleton-logo.js (~25KB of cosmetic stroke animation) keeps its external
// fetch but gains `defer` so it no longer blocks HTML parsing. Inline script
// hashes are recorded in the shared state so the CSP meta tag and the
// HTTP-header sidecar both allow them without `'unsafe-inline'`.
// Build-only: the dev CSP already carries `'unsafe-inline'` and dev boot
// latency isn't measured.
function inlineSkeletonScriptsPlugin(state: ImportMapBuildState): Plugin {
  const INLINE_TARGETS = ["skeleton-ready.js", "skeleton-stuck.js"] as const;
  return {
    name: "inline-skeleton-scripts",
    apply: "build",
    buildStart() {
      state.skeletonScriptHashes = [];
    },
    transformIndexHtml(html) {
      // Vite rewrites public-asset URLs against `base: "./"` before this hook
      // runs, so match any of /file, ./file, or bare file in the src.
      const tagRegexFor = (file: string): RegExp =>
        new RegExp(`<script\\s+src="\\.?/?${file.replace(".", "\\.")}"[^>]*></script>`);

      for (const file of INLINE_TARGETS) {
        const tagRegex = tagRegexFor(file);
        if (!tagRegex.test(html)) {
          throw new Error(
            `[inline-skeleton-scripts] Expected <script src="${file}"> tag in index.html`
          );
        }
        const source = readFileSync(path.join(process.cwd(), "public", file), "utf8");
        if (source.includes("</script>")) {
          throw new Error(
            `[inline-skeleton-scripts] public/${file} contains "</script>" and cannot be inlined`
          );
        }
        state.skeletonScriptHashes.push(
          `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`
        );
        html = html.replace(tagRegex, () => `<script>${source}</script>`);
      }

      const logoRegex = /<script\s+(src="\.?\/?skeleton-logo\.js")([^>]*)><\/script>/;
      if (!logoRegex.test(html)) {
        throw new Error(
          '[inline-skeleton-scripts] Expected <script src="skeleton-logo.js"> tag in index.html'
        );
      }
      return html.replace(logoRegex, (_m, src: string, rest: string) => {
        return /\bdefer\b/.test(rest) ? _m : `<script ${src}${rest} defer></script>`;
      });
    },
  };
}

// Bench builds only (DAINTREE_RENDER_PROBE=1, `npm run build:e2e:bench`):
// inlines scripts/perf/render-fanout-probe.js as a classic <head> script so
// the React DevTools hook it installs exists before any deferred module
// script evaluates react-dom. Classic-inline is the only placement that
// guarantees that ordering regardless of chunking; a src/ module import would
// also be vulnerable to sideEffects-based tree-shaking. The script hash rides
// state.skeletonScriptHashes so the meta CSP and the HTTP-header sidecar both
// allow it. Never active for shipped builds — the env var is only set by the
// bench build script.
function renderFanoutProbePlugin(state: ImportMapBuildState): Plugin {
  return {
    name: "render-fanout-probe",
    apply: "build",
    transformIndexHtml() {
      if (process.env.DAINTREE_RENDER_PROBE !== "1") return;
      const source = readFileSync(
        path.join(process.cwd(), "scripts", "perf", "render-fanout-probe.js"),
        "utf8"
      );
      if (source.includes("</script>")) {
        throw new Error(
          '[render-fanout-probe] scripts/perf/render-fanout-probe.js contains "</script>" and cannot be inlined'
        );
      }
      state.skeletonScriptHashes.push(
        `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`
      );
      return [
        {
          tag: "script",
          injectTo: "head-prepend" as const,
          children: source,
        },
      ];
    },
  };
}

// `HOST_IMPORTMAP_SPECIFIERS` (imported from @daintreehq/plugin-vite above) is
// the set of specifiers exposed to externalized plugin bundles. In production
// each bare specifier points at the same `vendor-react` chunk because Rolldown
// bundles `react`, `react-dom`, `scheduler`, and `use-sync-external-store` into
// one file (see the `vendor-react` codeSplitting group below). Trailing-slash
// mappings ("react/") can't substitute — a single chunk file has no subpath
// structure to concatenate against — so every JSX/React entrypoint plugins
// might import is listed explicitly in the shared constant. `scheduler` is
// internal to React and not exposed because no documented plugin path imports
// it directly; if that changes, add it to the shared constant (plugin-vite),
// which keeps the externals regex and this import map in lockstep by design.

const HOST_APP_ORIGIN = "app://daintree";

// Locate the vendor-react chunk by its codeSplitting `name`, which Rolldown
// preserves as `OutputChunk.name`. The hashed `.fileName` is what plugins (and
// the browser) must load, so the import map resolves bare React specifiers to
// that exact filename.
function findVendorReactChunkPath(
  bundle: Record<string, { type: string; name?: string; fileName?: string }>
): string | null {
  for (const output of Object.values(bundle)) {
    if (output.type === "chunk" && output.name === "vendor-react" && output.fileName) {
      return output.fileName;
    }
  }
  return null;
}

// Injects `<script type="importmap">` into the production index.html and emits
// `dist/importmap-meta.json` so the Electron main process can mirror the inline
// script hash into its HTTP `Content-Security-Policy` header. Dev builds are
// skipped — the dev server CSP carries `'unsafe-inline'` and `ctx.bundle` is
// undefined in serve mode, so there's nothing to map. The map exists so plugin
// bundles can declare React as an external and resolve to the host's single
// React instance at runtime; bundling a second copy of React produces "Invalid
// hook call" errors at the first JSX render.
function hostImportMapPlugin(state: ImportMapBuildState): Plugin {
  const sidecarPath = path.join(process.cwd(), "dist", "importmap-meta.json");

  return {
    name: "host-import-map",
    apply: "build",
    buildStart() {
      state.scriptSrcHash = null;
    },
    // Default-order hook (no `order` field). Vite calls default-order
    // transformIndexHtml hooks AFTER bundling so `ctx.bundle` is populated;
    // `order: "pre"` runs before bundling and would see `ctx.bundle ===
    // undefined`. cspTransformPlugin is the next default-order hook in the
    // plugin array, so it observes the hash this hook stores in shared state.
    transformIndexHtml(_html, ctx) {
      // `ctx.bundle` is populated only for production builds. In the dev
      // server the vendor-react chunk doesn't exist (Vite serves React from
      // the module graph), and an importmap pointing at a hashed filename
      // that won't be emitted would be a runtime 404.
      if (!ctx.bundle) return;

      const vendorReactPath = findVendorReactChunkPath(
        ctx.bundle as Record<string, { type: string; name?: string; fileName?: string }>
      );
      if (!vendorReactPath) {
        throw new Error(
          "[host-import-map] vendor-react chunk not found in build output. " +
            "Check the codeSplitting group with `name: 'vendor-react'` in vite.config.ts."
        );
      }

      const targetUrl = `${HOST_APP_ORIGIN}/${vendorReactPath}`;
      const importMapPayload = {
        imports: Object.fromEntries(
          HOST_IMPORTMAP_SPECIFIERS.map((specifier) => [specifier, targetUrl])
        ),
      };
      // Compact JSON without trailing whitespace — the byte sequence here is
      // exactly what the browser receives, and the SHA-256 must match.
      const serialized = JSON.stringify(importMapPayload);
      state.scriptSrcHash = `'sha256-${createHash("sha256").update(serialized, "utf8").digest("base64")}'`;

      return [
        {
          tag: "script",
          attrs: { type: "importmap" },
          // `head-prepend` places the importmap before the entry `<script
          // type="module">` so the browser parses it before resolving module
          // specifiers. Per the HTML spec, the integrity attribute is
          // FORBIDDEN on `<script type="importmap">`; a top-level `integrity`
          // block inside the JSON payload is the supported mechanism, but it
          // is only relevant when the map points at cross-origin chunks. The
          // host vendor chunk is same-origin, so no integrity block is
          // emitted today.
          injectTo: "head-prepend",
          children: serialized,
        },
      ];
    },
    closeBundle() {
      const allHashes = [
        ...(state.scriptSrcHash ? [state.scriptSrcHash] : []),
        ...state.skeletonScriptHashes,
      ];
      if (allHashes.length === 0) return;
      mkdirSync(path.dirname(sidecarPath), { recursive: true });
      writeFileSync(sidecarPath, JSON.stringify({ scriptSrcHashes: allHashes }, null, 2) + "\n");
    },
  };
}

// Prefix for the dev-only virtual modules that re-export the host's React. Each
// `HOST_IMPORTMAP_SPECIFIERS` entry gets one (`…/react`, `…/react-dom/client`,
// …). Vite serves a resolved virtual id at `/@id/<id>` in dev, so that URL is
// stable across runs — unlike the optimized-dep path (`/node_modules/.vite/
// deps/react.js?v=<hash>`), whose hash changes per optimize pass and can't be
// referenced statically from an import map.
const DEV_HOST_REACT_PREFIX = "virtual:daintree-host-react/";

// Dev counterpart to hostImportMapPlugin. In production the import map points
// plugin bundles at the hashed `vendor-react` chunk; in dev that chunk doesn't
// exist (Vite serves React from the module graph), so a sideloaded plugin view
// that externalizes React has nothing to resolve `react` against and fails to
// mount (#10514). This plugin closes that gap: it injects an import map into the
// dev index.html mapping each host specifier to a stable virtual module that
// re-exports the host's React. Because the virtual module's own `import` is
// resolved by Vite server-side (not via the browser import map), it lands on the
// exact React instance the host uses — one instance shared with every plugin,
// same guarantee as production. Serve-only; the dev CSP carries `'unsafe-inline'`
// so the inline `<script type="importmap">` needs no hash.
function hostImportMapDevPlugin(): Plugin {
  return {
    name: "host-import-map-dev",
    apply: "serve",
    resolveId(id) {
      if (id.startsWith(DEV_HOST_REACT_PREFIX)) return id;
      return null;
    },
    load(id) {
      if (!id.startsWith(DEV_HOST_REACT_PREFIX)) return null;
      const specifier = id.slice(DEV_HOST_REACT_PREFIX.length);
      const target = JSON.stringify(specifier);
      // `export *` carries the named exports (`useState`, `jsx`, …); the
      // computed default keeps `import React from "react"` working without a
      // direct `export { default }` that would throw for subpaths (e.g.
      // jsx-runtime) that have no own default export.
      return (
        `import * as m from ${target};\n` +
        `export * from ${target};\n` +
        `export default m.default ?? m;\n`
      );
    },
    transformIndexHtml(_html, ctx) {
      if (!ctx.server) return;
      const importMapPayload = {
        imports: Object.fromEntries(
          HOST_IMPORTMAP_SPECIFIERS.map((specifier) => [
            specifier,
            `/@id/${DEV_HOST_REACT_PREFIX}${specifier}`,
          ])
        ),
      };
      return [
        {
          tag: "script",
          attrs: { type: "importmap" },
          injectTo: "head-prepend",
          children: JSON.stringify(importMapPayload),
        },
      ];
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
// the app root plus every lazy panel chunk that loads on the first-render path,
// derived from the panel-kind registry (getFirstRenderPreloadSeeds). The
// check-first-render-chunk-budget script reads this artifact instead of a
// hardcoded list, so the seed set can never drift from the registry. Build-only;
// the seeds are static registry data, not bundle-derived, so this doesn't
// inspect the OutputBundle.
function firstRenderSeedsPlugin(): Plugin {
  const seedsPath = path.join(process.cwd(), "dist", ".vite", "first-render-seeds.json");

  return {
    name: "first-render-seeds",
    apply: "build",
    writeBundle() {
      const seeds = getFirstRenderPreloadSeeds();
      mkdirSync(path.dirname(seedsPath), { recursive: true });
      writeFileSync(seedsPath, JSON.stringify(seeds, null, 2) + "\n");
    },
  };
}

// Emits dist/chunk-modules.json after the build: a map of stable chunk name to
// the sorted, repo-relative source module IDs bundled into that chunk. The Vite
// manifest only records a chunk's single entry `src`, never its full module
// membership, so this sidecar is the only place per-chunk composition is
// observable. scripts/check-renderer-import-budget.mjs reads it to gate silent
// module migration between the critical T0 vendor chunks (#8890) — a module can
// hop chunks while both the eager chunk count and aggregate gzip stay in budget.
function chunkModulesPlugin(): Plugin {
  const outPath = path.join(process.cwd(), "dist", "chunk-modules.json");
  const root = process.cwd();

  return {
    name: "chunk-modules-sidecar",
    apply: "build",
    writeBundle(_options, bundle) {
      const chunkModules: Record<string, string[]> = {};
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const name = output.name || output.fileName;
        // Normalize to repo-relative forward-slash paths so the baseline is
        // stable across machines and OSes (absolute paths and "\" would churn).
        // Drop Rolldown virtual modules ("\0"-prefixed, e.g. the modulepreload
        // polyfill) — they normalize to machine-dependent "../" paths and would
        // produce spurious module-set diffs.
        chunkModules[name] = (output.moduleIds ?? [])
          .filter((id) => !id.startsWith("\0"))
          .map((id) => path.relative(root, id).split(path.sep).join("/"))
          .sort();
      }

      const sorted = Object.keys(chunkModules)
        .sort()
        .reduce<Record<string, string[]>>((acc, k) => {
          acc[k] = chunkModules[k];
          return acc;
        }, {});

      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(sorted, null, 2) + "\n");
    },
  };
}

// Prepends the V8 explicit-compile-hints magic comment (Chrome >=136; we ship
// Chromium 148) to a curated set of boot-hot chunks so V8 eagerly compiles all
// their functions in one background pass instead of lazily re-parsing each
// function at first call during boot. Biggest win on a cold app:// code cache
// (first launch, post-update). Curated on purpose, per V8 guidance to annotate
// only files where most functions actually run on load: the entry chunk, the
// App chunk, vendor-react, vendor-xterm, TerminalInstanceService, and
// appThemeStore. Everything else — explicitly including vendor-editor (~451KB
// of CodeMirror that is mostly uncalled at boot) and palette/settings/
// per-language chunks — is excluded to avoid wasted background compile and
// bytecode memory. Expand to the full first-render closure only if cold-cache
// perf samples confirm a win.
//
// Must run in generateBundle (NOT renderChunk, NOT the `banner` option):
// rolldown's native oxc minifier runs after renderChunk and would strip or
// displace the comment, and V8 only honors it on line 1. generateBundle runs
// post-minify, so the comment lands as the first line of the emitted file.
//
// The raw prepend is sourcemap-unsafe (it shifts every line by one without
// adjusting mappings). Acceptable here because production maps are not
// shipped — build.sourcemap is false in this config. If sourcemaps are ever
// enabled, this must move to a magic-string-based edit that remaps.
function compileHintsPlugin(): Plugin {
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

  const isHinted = (chunk: {
    isEntry: boolean;
    name: string;
    facadeModuleId?: string | null;
  }): boolean => {
    const facade = chunk.facadeModuleId?.split(path.sep).join("/");
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
  fileName: string;
  isEntry?: boolean;
  facadeModuleId?: string | null;
  imports?: string[];
  dynamicImports?: string[];
}

// Injects `<link rel="modulepreload">` for the eager static closure of the
// first-render seed chunks (the lazy browser/dev-preview/review panels a
// restored session renders immediately). Vite auto-preloads the entry chunk and
// everything in its static `imports[]` closure, but NOT chunks reached only
// through a dynamic import() boundary — so a restored panel's chunk and its
// private vendor deps download serially (parse entry → discover the lazy import
// → fetch the chunk → discover its deps → fetch those). Preloading the eager
// closure of the seeds collapses that first-paint waterfall.
//
// Eager-only by construction: the closure follows `imports[]` and NEVER
// `dynamicImports[]`, so deliberately-deferred subtrees (vendor-motion's domMax,
// #8821) are not pulled onto the first-paint path. The set-building logic lives
// in computeFirstRenderPreloadFiles (scripts/first-render-closure-lib.mjs),
// which shares the exact `followDynamic: false` traversal the first-render-chunk
// budget gates on, so the injected preload set and the measured budget cannot
// drift. Chunk membership is untouched — this only adds <link> tags to the HTML.
function firstRenderModulePreloadPlugin(): Plugin {
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

      const chunks = Object.values(ctx.bundle as unknown as Record<string, BundleChunkLike>);
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
      return files.map(
        (fileName): HtmlTagDescriptor => ({
          tag: "link",
          attrs: { rel: "modulepreload", crossorigin: true, href: `./${fileName}` },
          injectTo: "head",
        })
      );
    },
  };
}

function latin400FontPreloadPlugin(): Plugin {
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

export default defineConfig(({ command, mode }) => {
  const { logger: compilerLogger, plugin: compilerReportPlugin } =
    reactCompilerReportPlugin(command);
  const importMapState = createImportMapState();
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
      compileHintsPlugin(),
      xtermMinifyIdentifiersGuardPlugin(),
      ...(process.env.ANALYZE === "true"
        ? [visualizer({ filename: "stats.html", gzipSize: true, brotliSize: true }) as Plugin]
        : []),
    ],
    base: "./",
    build: {
      target: "chrome148",
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
                test: (id: string) => {
                  if (id.includes("\0") || id.includes(".html")) return false;
                  return !id.split(path.sep).join("/").endsWith("src/main.tsx");
                },
                priority: 1,
                maxSize: 400_000,
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
