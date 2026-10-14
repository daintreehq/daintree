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

// Mirrors vite.config.ts: every alias into repo source, so a route back into
// the app through a workspace package is walked rather than left external.
const ALIASES = {
  "@": "./src",
  "@shared": "./shared",
  "@daintreehq/tour/react": "./packages/tour/src/react.ts",
  "@daintreehq/tour/kit": "./packages/tour/src/kit.ts",
  "@daintreehq/tour/mock-app": "./packages/tour/src/mock-app.ts",
  "@daintreehq/tour": "./packages/tour/src/index.ts",
  "@daintreehq/plugin-ui": "./src/pluginUi/index.ts",
  "@daintreehq/plugin-sdk/react": "./packages/plugin-sdk/src/react.ts",
};

// `build.resolve` skips aliases, which a worker import still needs.
function unalias(spec) {
  for (const [from, to] of Object.entries(ALIASES)) {
    if (spec === from) return to;
    if (spec.startsWith(`${from}/`)) return `${to}${spec.slice(from.length)}`;
  }
  return spec;
}

// Vite query imports: `?url`, `?raw` and `?inline` are assets, not modules,
// but a `?worker` is code the kit would run, so it is walked like any import.
const viteQueryImports = {
  name: "vite-query-imports",
  setup(b) {
    b.onResolve({ filter: /\?(?:url|raw|inline)$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
    b.onResolve({ filter: /\?worker$/ }, (args) => {
      const raw = args.path.replace(/\?worker$/, "");
      const spec = unalias(raw);
      return b.resolve(spec, {
        kind: args.kind,
        // An aliased path is relative to the repository root, as in `alias`.
        resolveDir: spec === raw ? args.resolveDir : ROOT,
        importer: args.importer,
      });
    });
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
  alias: ALIASES,

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
