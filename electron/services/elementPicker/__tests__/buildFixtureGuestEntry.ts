import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");

/**
 * Bundles a fixture plugin's guest entry to the shape `daintreePlugin({ target:
 * "guest" })` emits — one standalone IIFE assigning `__daintreeExtractor`.
 * Out of process for the reason `buildCoreGuestAssets` is: esbuild cannot start
 * inside a jsdom suite. The plugin-vite build itself is covered by its own tests.
 */
export function buildFixtureGuestEntry(entry: string): string {
  const script = [
    'const esbuild = require("esbuild");',
    "esbuild",
    "  .build({",
    `    entryPoints: [${JSON.stringify(path.resolve(repoRoot, entry))}],`,
    "    bundle: true,",
    '    format: "iife",',
    '    globalName: "__daintreeExtractor",',
    '    target: "es2022",',
    "    write: false,",
    '    logLevel: "silent",',
    '    outfile: "out/entry.js",',
    "  })",
    "  .then((result) => process.stdout.write(result.outputFiles[0].text))",
    "  .catch((err) => { console.error(err); process.exit(1); });",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`fixture guest entry build failed: ${result.stderr || result.error?.message}`);
  }
  return result.stdout;
}

/**
 * Bundles a fixture plugin's resolver entry to one standalone ES module, the
 * shape a plugin resolver host imports. Out of process, as above.
 */
export function buildFixtureResolverEntry(entry: string): string {
  const script = [
    'const esbuild = require("esbuild");',
    "esbuild",
    "  .build({",
    `    entryPoints: [${JSON.stringify(path.resolve(repoRoot, entry))}],`,
    "    bundle: true,",
    '    format: "esm",',
    '    platform: "node",',
    '    target: "node22",',
    "    write: false,",
    '    logLevel: "silent",',
    '    outfile: "out/resolver.mjs",',
    "  })",
    "  .then((result) => process.stdout.write(result.outputFiles[0].text))",
    "  .catch((err) => { console.error(err); process.exit(1); });",
  ].join("\n");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `fixture resolver entry build failed: ${result.stderr || result.error?.message}`
    );
  }
  return result.stdout;
}
