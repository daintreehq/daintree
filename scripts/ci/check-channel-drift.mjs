#!/usr/bin/env node
// Verifies `electron/preload.cts` imports CHANNELS from `electron/ipc/channels.ts`
// rather than inlining a duplicate copy. esbuild bundles the preload, so this
// import is resolved at build time — the preload never imports channels.ts at
// runtime. See #5691 for the migration away from the hand-maintained inline copy.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const PRELOAD_FILE = path.join(root, "electron/preload.cts");

const source = readFileSync(PRELOAD_FILE, "utf8");

const IMPORT_RE = /^import\s*\{[^}]*\bCHANNELS\b[^}]*\}\s*from\s*["']\.\/ipc\/channels\.js["'];?$/m;
const INLINE_RE = /(?:^|\n)\s*(?:export\s+)?const\s+CHANNELS\s*=\s*\{/;

let failures = 0;

if (!IMPORT_RE.test(source)) {
  console.error(
    `::error file=${PRELOAD_FILE}::missing canonical import. electron/preload.cts must ` +
      `\`import { CHANNELS } from "./ipc/channels.js"\` so esbuild bundles the single source of truth.`
  );
  failures++;
}

if (INLINE_RE.test(source)) {
  console.error(
    `::error file=${PRELOAD_FILE}::electron/preload.cts declares its own \`const CHANNELS = { ... }\`. ` +
      `Remove the inline copy — CHANNELS lives in electron/ipc/channels.ts and is bundled by esbuild.`
  );
  failures++;
}

if (failures > 0) {
  console.error(
    `\nchannel drift detected: ${failures} issue(s). See electron/preload.cts and electron/ipc/channels.ts.`
  );
  process.exit(1);
}

console.log("[check-channel-drift] OK — preload consumes channels.ts via import");
