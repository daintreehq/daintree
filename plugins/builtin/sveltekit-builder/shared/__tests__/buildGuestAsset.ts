import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const entry = "plugins/builtin/sveltekit-builder/renderer/guest/entry.ts";

/**
 * Builds the guest runtime asset the way `scripts/build-main.mjs` does, so the
 * tests around it run the production script rather than the factory it was
 * bundled from. Kept in step with `guestRuntimeBuildConfig` there.
 *
 * Out of process because these suites run under jsdom, whose `TextEncoder`
 * fails esbuild's startup invariant — importing esbuild at all would kill the
 * file before a test ran.
 */
export function buildGuestAsset(options: { minify?: boolean } = {}): string {
  const config = {
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: options.minify === true,
    sourcemap: false,
    logLevel: "silent",
    absWorkingDir: repoRoot,
    banner: { js: "(() => {" },
    footer: { js: "})();" },
  };

  const result = spawnSync(
    process.execPath,
    [
      "-e",
      'const esbuild = require("esbuild");' +
        "esbuild" +
        ".build(JSON.parse(process.argv[1]))" +
        ".then((r) => process.stdout.write(r.outputFiles[0].text))" +
        ".catch((err) => { console.error(err); process.exit(1); });",
      JSON.stringify(config),
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );

  if (result.status !== 0) {
    throw new Error(`guest runtime build failed: ${result.stderr || result.error?.message}`);
  }
  if (!result.stdout) throw new Error("esbuild emitted no guest runtime asset");
  return result.stdout;
}
