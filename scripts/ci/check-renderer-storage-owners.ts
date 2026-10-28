#!/usr/bin/env tsx
// Every key the renderer persists to web storage — a zustand `persist` store's
// `name`, a localStorage key — must have an owner and scope in
// `shared/config/settingOwnership.ts`, so a new persisted setting can't appear
// without someone deciding whose it is. A key the scan can't read takes a
// `// storage-key: <key>` comment naming it. #14695

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SETTING_CATALOG } from "../../shared/config/settingOwnership.js";
import { checkRendererStorage } from "./rendererStorageCheck.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP_DIR = /^(?:__tests__|__bench__|__preview__|__mocks__|node_modules)$/;
const SKIP_FILE = /\.(?:test|spec|stories)\.tsx?$|\.d\.ts$/;

function walk(dir: string, into: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.test(entry.name)) walk(full, into);
    } else if (/\.tsx?$/.test(entry.name) && !SKIP_FILE.test(entry.name)) {
      into.set(path.relative(root, full), readFileSync(full, "utf8"));
    }
  }
}

const sources = new Map<string, string>();
walk(path.join(root, "src"), sources);

const declared = [
  ...Object.keys(SETTING_CATALOG["renderer-local-storage"].entries),
  ...Object.keys(SETTING_CATALOG["renderer-session-storage"].entries),
];
const problems = checkRendererStorage(sources, declared);
for (const problem of problems) console.error(`::error file=${problem.file}::${problem.message}`);
if (problems.length > 0) {
  console.error(
    `\n${problems.length} renderer storage problem(s). Declare keys in SETTING_CATALOG ` +
      `("renderer-local-storage") in shared/config/settingOwnership.ts.`
  );
  process.exit(1);
}
console.log("Every renderer storage key declares an owner and scope.");
