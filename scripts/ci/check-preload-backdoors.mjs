#!/usr/bin/env node
// Verifies that E2E test backdoors are stripped from the packaged bundles
// (#9148, extended in #10026). The preload exposes three
// `contextBridge.exposeInMainWorld` bridges (`__DAINTREE_E2E_*`) gated only by
// env-var reads — not a security boundary. The main-process bundles read a
// further set of `DAINTREE_E2E_*` flags (sideload dir, crash-dump redirect,
// renderer-load deferral, CPU-throttle disable) that influence file paths and
// plugin roots in production if they ever survive a build.
//
// Production builds replace those env reads with "" via esbuild defines
// (scripts/build-main.mjs), so the minifier dead-code-eliminates the bridges
// and guarded branches. This gate runs after a production `npm run build` and
// fails if any forbidden string survives in the compiled preload OR in any of
// the main-process bundles under dist-electron/electron/ (including the
// split shared chunks) — the env-var names or the exposed global keys both
// indicate the strip regressed.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const ELECTRON_DIR = path.join(root, "dist-electron/electron");

// The `DAINTREE_E2E_*` env reads that scripts/build-main.mjs replaces with ""
// in production via esbuild `define`. Single source of truth: the companion
// test asserts every entry here also appears in FORBIDDEN, so the define list
// and the gate cannot silently diverge again (the #10026 root cause).
export const STRIPPED_BY_BUILD = [
  "DAINTREE_E2E_FAULT_MODE",
  "DAINTREE_E2E_MODE",
  "DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS",
  "DAINTREE_E2E_SIDELOAD_PLUGIN_DIR",
  "DAINTREE_E2E_DISABLE_CACHED_VIEW_CPU_THROTTLE",
  "DAINTREE_E2E_CRASH_DUMPS_DIR",
  "DAINTREE_E2E_DEFER_RENDERER_LOAD",
];

// Both the exposed global keys and the gating env-var names. If the env reads
// were not replaced, the names survive even when minify happens to drop the
// branch body, so checking both is strictly safer.
export const FORBIDDEN = [
  "__DAINTREE_E2E_IPC__",
  "__DAINTREE_E2E_MODE__",
  "__DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__",
  "__daintreeActivateE2EPlugin",
  ...STRIPPED_BY_BUILD,
];

/** Return the forbidden strings found in a single bundle's text content. */
export function scanBundleForForbidden(content, forbidden = FORBIDDEN) {
  return forbidden.filter((needle) => content.includes(needle));
}

/**
 * Collect every emitted JS bundle under `dir` (recursively): main.js, the host
 * entries, the split `chunks/*.js`, and the CJS preload. Excludes sourcemaps
 * (`*.map`) and non-JS assets. esbuild `splitting: true` can place a stripped
 * branch in a shared chunk, so scanning only main.js would miss it.
 */
export function collectMainBundles(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectMainBundles(abs));
    } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))) {
      found.push(abs);
    }
  }
  return found.sort();
}

/**
 * Run the gate. Returns `{ ok, errors }` rather than calling process.exit so
 * the logic stays unit-testable; the CLI wrapper below maps it to an exit code.
 */
export function runGate({ electronDir = ELECTRON_DIR } = {}) {
  const errors = [];

  const required = [path.join(electronDir, "preload.cjs"), path.join(electronDir, "main.js")];
  for (const file of required) {
    if (!existsSync(file)) {
      errors.push(
        `${path.relative(root, file)} not found. Run a production build ` +
          `(\`npm run build\`) before \`npm run check:preload-backdoors\`.`
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const bundles = collectMainBundles(electronDir);
  const hits = [];
  for (const file of bundles) {
    const content = readFileSync(file, "utf8");
    for (const needle of scanBundleForForbidden(content)) {
      hits.push({ file: path.relative(root, file), needle });
    }
  }

  if (hits.length > 0) {
    for (const { file, needle } of hits) {
      errors.push(
        `::error file=${file}::E2E backdoor "${needle}" survived in the ` +
          `production bundle. The esbuild defines in scripts/build-main.mjs ` +
          `must strip it — confirm NODE_ENV=production and minify are active.`
      );
    }
    errors.push(
      `\nbackdoor check failed: ${hits.length} forbidden string(s) in the packaged bundles.`
    );
    return { ok: false, errors };
  }

  return { ok: true, errors: [] };
}

// CLI entry — only runs when invoked directly, not when imported by the test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { ok, errors } = runGate();
  if (!ok) {
    for (const line of errors) console.error(line);
    process.exit(1);
  }
  console.log("[check-preload-backdoors] OK — no E2E backdoors in the production bundles");
}
