import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  getDevServerConfig,
  getDevServerOrigins,
  getDevServerWebSocketOrigins,
} from "./shared/config/devServer";

const devServerConfig = getDevServerConfig();
const devServerOrigins = getDevServerOrigins();
const devServerWebSocketOrigins = getDevServerWebSocketOrigins();

const IS_LEGACY_BUILD = process.env.BUILD_VARIANT === "canopy";
// Custom protocol schemes used by the app's file handlers. Both schemes stay
// whitelisted through the 0.8 migration window so Daintree can still load
// persisted canopy-file:// URLs after a manual reinstall from Canopy.
const FILE_SCHEMES = "daintree-file: canopy-file:";

// CSP definitions for development and production
const DEV_CSP = [
  `default-src 'self' ${devServerOrigins.join(" ")} ${devServerWebSocketOrigins.join(" ")}`,
  `script-src 'self' ${devServerOrigins.join(" ")} 'unsafe-eval'`,
  `style-src 'self' ${devServerOrigins.join(" ")} 'unsafe-inline'`,
  "font-src 'self' data:",
  `connect-src 'self' ${devServerOrigins.join(" ")} ${devServerWebSocketOrigins.join(" ")} ${FILE_SCHEMES}`,
  `img-src 'self' ${devServerOrigins.join(" ")} https://avatars.githubusercontent.com ${FILE_SCHEMES} data:`,
  "frame-src 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
].join("; ");

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  `connect-src 'self' ${FILE_SCHEMES}`,
  `img-src 'self' https://avatars.githubusercontent.com ${FILE_SCHEMES} data: blob:`,
  "frame-src 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

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
        const sorted = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
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

export default defineConfig(({ command, mode }) => {
  const { logger: compilerLogger, plugin: compilerReportPlugin } =
    reactCompilerReportPlugin(command);
  return {
    envPrefix: ["VITE_", "DAINTREE_"],
    define: {
      IS_LEGACY_BUILD: JSON.stringify(IS_LEGACY_BUILD),
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
    ],
    base: "./",
    build: {
      target: "chrome144",
      modulePreload: { polyfill: false },
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
      rolldownOptions: {
        ...(mode === "production" && {
          treeshake: {
            manualPureFunctions: ["console.log", "console.info", "console.warn", "console.debug"],
          },
        }),
        output: {
          codeSplitting: {
            groups: [
              { name: "vendor-xterm", test: /node_modules[\\/]@xterm[\\/]/, priority: 70 },
              {
                name: "vendor-editor",
                test: /node_modules[\\/](@codemirror[\\/]|@uiw[\\/]|refractor[\\/])/,
                priority: 60,
              },
              {
                name: "vendor-motion",
                test: /node_modules[\\/]framer-motion[\\/]/,
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
              { name: "vendor", test: /node_modules[\\/]/, priority: 10 },
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
