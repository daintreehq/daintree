#!/usr/bin/env node
// Verifies that E2E test backdoors are stripped from the packaged preload (#9148).
// The preload exposes three `contextBridge.exposeInMainWorld` bridges
// (`__DAINTREE_E2E_*`) gated only by env-var reads — not a security boundary.
// Production builds replace those env reads with "" via esbuild defines
// (scripts/build-main.mjs), so the minifier dead-code-eliminates the bridges.
// This gate runs after a production `npm run build` and fails if any of the
// forbidden strings survive in the compiled CJS preload — the env-var names or
// the exposed global keys both indicate the strip regressed.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const PRELOAD_BUNDLE = path.join(root, "dist-electron/electron/preload.cjs");

// Both the exposed global keys and the gating env-var names. If the env reads
// were not replaced, the names survive even when minify happens to drop the
// branch body, so checking both is strictly safer.
const FORBIDDEN = [
  "__DAINTREE_E2E_IPC__",
  "__DAINTREE_E2E_MODE__",
  "__DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS__",
  "DAINTREE_E2E_FAULT_MODE",
  "DAINTREE_E2E_MODE",
  "DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS",
];

if (!existsSync(PRELOAD_BUNDLE)) {
  console.error(
    `::error::${PRELOAD_BUNDLE} not found. Run a production build ` +
      `(\`npm run build\`) before \`npm run check:preload-backdoors\`.`
  );
  process.exit(1);
}

const bundle = readFileSync(PRELOAD_BUNDLE, "utf8");

const hits = FORBIDDEN.filter((needle) => bundle.includes(needle));

if (hits.length > 0) {
  for (const hit of hits) {
    console.error(
      `::error file=dist-electron/electron/preload.cjs::E2E backdoor "${hit}" ` +
        `survived in the production preload. The esbuild defines in ` +
        `scripts/build-main.mjs must strip it — confirm NODE_ENV=production and ` +
        `minify are active.`
    );
  }
  console.error(
    `\npreload backdoor check failed: ${hits.length} forbidden string(s) in the packaged preload.`
  );
  process.exit(1);
}

console.log("[check-preload-backdoors] OK — no E2E backdoors in the production preload");
