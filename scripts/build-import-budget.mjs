#!/usr/bin/env node

// Builds an esbuild metafile rooted at `electron/main.ts` and writes it to
// `dist-electron/eager-import-meta.json`. The metafile is a static snapshot of
// the import graph that `check-import-budget.mjs` walks to count eagerly
// imported modules (stopping at dynamic-import boundaries) and to scan for
// sync filesystem / store / SQLite calls on the eager path.
//
// Intentional separation from `build-main.mjs`: we mirror the same `external`
// list, `define` block, and target so the graph matches the real build, but
// we use `write: false` and a single entry point so we never touch
// `dist-electron/electron/*.js` — the working build artifacts stay intact.

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const buildVariant = process.env.BUILD_VARIANT === "canopy" ? "canopy" : "daintree";
const isLegacyBuild = buildVariant === "canopy";

const external = ["electron", "node-pty", "better-sqlite3", "copytree"];

const METAFILE_OUT = path.join(root, "dist-electron", "eager-import-meta.json");

async function run() {
  const result = await build({
    entryPoints: ["electron/main.ts"],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external,
    absWorkingDir: root,
    logLevel: "warning",
    define: {
      "process.env.SENTRY_DSN": JSON.stringify(process.env.SENTRY_DSN || ""),
      "process.env.BUILD_VARIANT": JSON.stringify(buildVariant),
      IS_LEGACY_BUILD: JSON.stringify(isLegacyBuild),
    },
  });

  fs.mkdirSync(path.dirname(METAFILE_OUT), { recursive: true });
  fs.writeFileSync(METAFILE_OUT, JSON.stringify(result.metafile, null, 2) + "\n");

  const inputCount = Object.keys(result.metafile.inputs).length;
  console.log(
    `[build-import-budget] metafile written to ${path.relative(root, METAFILE_OUT)} (${inputCount} bundled inputs)`
  );
}

run().catch((err) => {
  console.error("[build-import-budget] failed:", err);
  process.exit(1);
});
