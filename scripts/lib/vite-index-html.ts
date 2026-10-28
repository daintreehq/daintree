import type { Plugin } from "vite";
import path from "path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getDaintreeAppDevCSP, getDaintreeAppProdCSP } from "../../shared/config/csp";

// CSP definitions for development and production. Single source of truth lives
// in shared/config/csp.ts so the meta tag injected here and the HTTP header set
// by the main process stay in sync — the browser intersects header + meta, so
// any divergence silently tightens the effective policy and breaks the app.
const DEV_CSP = getDaintreeAppDevCSP();

// Shared state between hostImportMapPlugin and cspTransformPlugin. Both hooks
// use default-order transformIndexHtml; Vite preserves plugin-array order for
// same-order hooks, and the array places hostImportMapPlugin before
// cspTransformPlugin so the hash is set before the CSP meta tag is rewritten.
// (`order: "pre"` would run before bundling and yield `ctx.bundle === undefined`,
// hiding the vendor-react chunk path.) `buildStart` resets the hash so a
// watch-mode rebuild can't reuse stale state from the previous build.
export interface ImportMapBuildState {
  scriptSrcHash: string | null;
  /**
   * SHA-256 hashes for the boot-skeleton scripts inlined into index.html by
   * inlineSkeletonScriptsPlugin. Written by that plugin, read by
   * cspTransformPlugin (meta CSP) and hostImportMapPlugin's closeBundle
   * (HTTP-header CSP sidecar) so all three layers stay aligned.
   */
  skeletonScriptHashes: string[];
}

export function createImportMapState(): ImportMapBuildState {
  return { scriptSrcHash: null, skeletonScriptHashes: [] };
}

// Plugin to transform CSP meta tag based on build mode. In production it pulls
// the host import-map hash from the shared state so the inline importmap script
// satisfies `script-src` without weakening the policy with `'unsafe-inline'`.
export function cspTransformPlugin(state: ImportMapBuildState): Plugin {
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
export function inlineSkeletonScriptsPlugin(state: ImportMapBuildState): Plugin {
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
export function renderFanoutProbePlugin(state: ImportMapBuildState): Plugin {
  return {
    name: "render-fanout-probe",
    apply: "build",
    transformIndexHtml() {
      if (process.env.DAINTREE_RENDER_PROBE !== "1") return;
      // Loud on purpose: a globally exported DAINTREE_RENDER_PROBE=1 would
      // otherwise silently turn a packaging build into a bench build
      // (inline probe + profiling react-dom + no minification).
      console.warn(
        "[render-fanout-probe] BENCH BUILD: inlining render probe, profiling react-dom, minify off — never ship this build"
      );
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
