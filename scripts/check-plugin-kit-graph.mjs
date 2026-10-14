#!/usr/bin/env node

// Fails when the plugin UI kit's module graph reaches the app's wiring (see
// plugin-kit-graph-lib.mjs). Bundles the kit in memory with esbuild, packages
// external and assets empty, and walks the metafile; no build output needed.
//
// Usage: node scripts/check-plugin-kit-graph.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { KIT_ENTRIES, findForbiddenKitReach, formatKitReach } from "./plugin-kit-graph-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ASSET_LOADERS = Object.fromEntries(
  [".css", ".svg", ".png", ".jpg", ".gif", ".webp", ".woff", ".woff2", ".ttf", ".wasm"].map(
    (ext) => [ext, "empty"]
  )
);

// Vite query imports (`?url`, `?raw`, `?worker`) are assets, not modules.
const viteQueryImports = {
  name: "vite-query-imports",
  setup(b) {
    b.onResolve({ filter: /\?(?:url|raw|worker|inline)$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const result = await build({
  absWorkingDir: ROOT,
  entryPoints: KIT_ENTRIES,
  bundle: true,
  splitting: true,
  format: "esm",
  write: false,
  metafile: true,
  outdir: "out",
  logLevel: "silent",
  jsx: "automatic",
  packages: "external",
  // Mirrors the `@` and `@shared` aliases in vite.config.ts and tsconfig.json.
  alias: { "@": "./src", "@shared": "./shared" },
  loader: ASSET_LOADERS,
  plugins: [viteQueryImports],
}).catch((err) => {
  console.error(`::error::esbuild could not bundle the plugin UI kit: ${err.message}`);
  process.exit(1);
});

const { hits, moduleCount } = findForbiddenKitReach(result.metafile, KIT_ENTRIES);

if (hits.length > 0) {
  console.error(
    `::error::The plugin UI kit reaches app wiring it must get through kitHost instead (${hits.length}):`
  );
  console.error(formatKitReach(hits));
  process.exit(1);
}

console.log(`Plugin UI kit graph clean (${moduleCount} local modules).`);
