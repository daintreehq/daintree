import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { visualizer } from "rollup-plugin-visualizer";
import path from "path";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { getDevServerConfig } from "./shared/config/devServer";
import { getDaintreeAppDevCSP, getDaintreeAppProdCSP } from "./shared/config/csp";

const devServerConfig = getDevServerConfig();

// CSP definitions for development and production. Single source of truth lives
// in shared/config/csp.ts so the meta tag injected here and the HTTP header set
// by the main process stay in sync — the browser intersects header + meta, so
// any divergence silently tightens the effective policy and breaks the app.
const DEV_CSP = getDaintreeAppDevCSP();
const PROD_CSP = getDaintreeAppProdCSP();

// Per-file accumulator written to dist/compiler-bailout-report.json after the
// build completes. Counts come from babel-plugin-react-compiler's logger:
// CompileSuccess, CompileSkip, CompileError, PipelineError. Other event kinds
// (Timing, CompileDiagnostic, AutoDeps*) are ignored — they aren't regression
// signals. The accumulator Map and the logger object MUST be created in the
// same factory call so they share state via closure; threading either through
// module scope would silently produce an empty report.
type CompilerBailoutCounts = {
  success: number;
  skip: number;
  error: number;
  pipeline: number;
};

type CompilerLoggerEvent = { kind: string };

type CompilerLogger = {
  logEvent: (filename: string | null, event: CompilerLoggerEvent) => void;
};

function reactCompilerReportPlugin(command: "build" | "serve"): {
  plugin: Plugin;
  logger: CompilerLogger;
} {
  const counts = new Map<string, CompilerBailoutCounts>();
  const cwd = process.cwd();
  const reportPath = path.join(cwd, "dist", "compiler-bailout-report.json");

  function bump(filename: string, key: keyof CompilerBailoutCounts) {
    let entry = counts.get(filename);
    if (!entry) {
      entry = { success: 0, skip: 0, error: 0, pipeline: 0 };
      counts.set(filename, entry);
    }
    entry[key]++;
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
      switch (event.kind) {
        case "CompileSuccess":
          bump(rel, "success");
          break;
        case "CompileSkip":
          bump(rel, "skip");
          break;
        case "CompileError":
          bump(rel, "error");
          break;
        case "PipelineError":
          bump(rel, "pipeline");
          break;
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
        const out: Record<string, CompilerBailoutCounts> = {};
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
          }),
        ],
      }),
      tailwindcss(),
      cspTransformPlugin(),
      compilerReportPlugin,
      rendererBundleSizePlugin(),
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
              { name: "vendor-xterm", test: /node_modules[\\/]@xterm[\\/]/, priority: 70 },
              {
                name: "vendor-editor",
                test: /node_modules[\\/](@codemirror[\\/]|@uiw[\\/]|refractor[\\/](?!lang[\\/]))/,
                priority: 60,
              },
              {
                name: "vendor-motion",
                test: /node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/,
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
                name: "vendor-radix",
                test: /node_modules[\\/]@radix-ui[\\/]/,
                priority: 12,
              },
              {
                name: "vendor",
                test: /node_modules[\\/](?!refractor[\\/]lang[\\/])/,
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
