import type { Plugin } from "vite";
import path from "path";
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { isInScanSurface } from "./compiler-scan-surface.mjs";
import { getFirstRenderPreloadSeeds } from "../../shared/config/panelKindRegistry";
import { isHostFacadeChunkName } from "./vite-host-facade";

type CompilerLoggerEvent = { kind: string };

type CompilerLogger = {
  logEvent: (filename: string | null, event: CompilerLoggerEvent) => void;
};

// Proves the React Compiler is still wired into the real build, and nothing
// else. It used to accumulate per-file diagnostics and write
// dist/compiler-bailout-report.json, which the bailout budget then diffed —
// but a bundler only ever sees what its module graph reaches, so that report
// moved with tree-shaking, dynamic imports and entry changes for reasons
// unrelated to compiler health, and the budget it fed drifted with it. The
// budget is measured by `scripts/lib/compiler-scan.mjs` now, over files on
// disk. What a build can still tell us, and a scan cannot, is whether the
// logger is plumbed into `reactCompilerPreset` at all.
//
// The counter and the logger MUST be created in the same factory call so they
// share state via closure; threading either through module scope would leave
// this assertion watching an object nothing writes to.
export function reactCompilerReportPlugin(command: "build" | "serve"): {
  plugin: Plugin;
  logger: CompilerLogger;
} {
  let eventCount = 0;
  const offSurface = new Set<string>();
  const cwd = process.cwd();

  const logger: CompilerLogger = {
    logEvent(filename) {
      if (command !== "build") return;
      if (!filename) return;
      eventCount++;
      const rel = path.relative(cwd, filename).split(path.sep).join("/");
      if (!rel || rel.startsWith("../")) return;
      if (!isInScanSurface(rel)) offSurface.add(rel);
    },
  };

  return {
    logger,
    plugin: {
      name: "react-compiler-report",
      apply: "build",
      buildStart() {
        // Reset between builds — `vite build --watch` and anything else that
        // triggers a second build in the same process would otherwise carry a
        // stale non-zero count past a genuine wiring break.
        eventCount = 0;
        offSurface.clear();
      },
      closeBundle() {
        if (command !== "build") return;
        if (eventCount === 0) {
          throw new Error(
            "[react-compiler-report] logger received zero events; check that the logger from reactCompilerReportPlugin() is passed into reactCompilerPreset({ logger })."
          );
        }
        if (offSurface.size > 0) {
          // The budget scans files on disk, so a renderer file living outside
          // the declared patterns is never measured — and moving one there
          // retires its debt silently, because the old path just reads as
          // deleted. The build is the only place that sees the real set of
          // files the compiler touches, so this is where that gap closes.
          throw new Error(
            `[react-compiler-report] the React Compiler processed ${offSurface.size} file(s) outside the bailout-budget scan surface, so their diagnostics are untracked:\n` +
              [...offSurface]
                .sort()
                .map((f) => `  ${f}`)
                .join("\n") +
              "\nAdd them to SCAN_PATTERNS in scripts/lib/compiler-scan-surface.mjs, or move them back under an existing pattern."
          );
        }
      },
    },
  };
}

// Emits dist/renderer-bundle-size-report.json after the build completes with
// per-chunk and total JS/CSS sizes (raw + gzip). Used by the CI bundle size
// budget gate to catch silent regressions from dependency upgrades or
// accidental full-library imports.
export function rendererBundleSizePlugin(): Plugin {
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
          // The app entry specifically, not merely the first `isEntry` chunk:
          // hostFacadePlugin emits the import-map facades as additional
          // entries, and bundle order does not guarantee the app comes first.
          if (output.isEntry && !isHostFacadeChunkName(name)) {
            entryChunkName ??= name;
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
// the static first-render seeds (the app root), derived from the panel-kind
// registry (getFirstRenderPreloadSeeds). The
// check-first-render-chunk-budget script reads this artifact instead of a
// hardcoded list, so the seed set can never drift from the registry. Build-only;
// the seeds are static registry data, not bundle-derived, so this doesn't
// inspect the OutputBundle.
export function firstRenderSeedsPlugin(): Plugin {
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
//
// Names are not unique (dozens of chunks are called `boot` or `dist`), so a
// name-keyed entry can silently stand for the last of several chunks. The
// second sidecar, dist/chunk-modules-by-file.json, keys the same lists by
// emitted file, which is what scripts/ci/check-element-picker-bundles.mjs
// needs to see every chunk the manifest walks to.
export function chunkModulesPlugin(): Plugin {
  const outPath = path.join(process.cwd(), "dist", "chunk-modules.json");
  const byFilePath = path.join(process.cwd(), "dist", "chunk-modules-by-file.json");
  const root = process.cwd();

  return {
    name: "chunk-modules-sidecar",
    apply: "build",
    writeBundle(_options, bundle) {
      const chunkModules: Record<string, string[]> = {};
      const byFile: Record<string, string[]> = {};
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const name = output.name || output.fileName;
        // Normalize to repo-relative forward-slash paths so the baseline is
        // stable across machines and OSes (absolute paths and "\" would churn).
        // Drop Rolldown virtual modules ("\0"-prefixed, e.g. the modulepreload
        // polyfill) — they normalize to machine-dependent "../" paths and would
        // produce spurious module-set diffs.
        const modules = (output.moduleIds ?? [])
          .filter((id) => !id.startsWith("\0"))
          .map((id) => path.relative(root, id).split(path.sep).join("/"))
          .sort();
        chunkModules[name] = modules;
        byFile[output.fileName] = modules;
      }
      mkdirSync(path.dirname(byFilePath), { recursive: true });
      writeFileSync(byFilePath, JSON.stringify(byFile) + "\n");

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
