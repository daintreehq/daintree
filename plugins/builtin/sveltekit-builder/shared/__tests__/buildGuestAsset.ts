import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const buildScript = pathToFileURL(path.join(repoRoot, "scripts/build-main.mjs")).href;

/**
 * Builds the guest runtime asset with the configuration `scripts/build-main.mjs`
 * itself exports, so the tests around it run the production script — banner,
 * footer, target and all — rather than a copy that could drift from it.
 *
 * Out of process because these suites run under jsdom, whose `TextEncoder`
 * fails esbuild's startup invariant — importing esbuild at all would kill the
 * file before a test ran.
 */
export function buildGuestAsset(options: { minify?: boolean } = {}): string {
  const script = [
    'const esbuild = require("esbuild");',
    `import(${JSON.stringify(buildScript)})`,
    "  .then((m) => esbuild.build({",
    "    ...m.guestRuntimeBuildConfig(m.GUEST_RUNTIME_ASSETS[0], {",
    `      minify: ${options.minify === true},`,
    `      absWorkingDir: ${JSON.stringify(repoRoot)},`,
    "    }),",
    "    write: false,",
    '    logLevel: "silent",',
    "  }))",
    "  .then((r) => process.stdout.write(r.outputFiles[0].text))",
    "  .catch((err) => { console.error(err); process.exit(1); });",
  ].join("\n");

  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`guest runtime build failed: ${result.stderr || result.error?.message}`);
  }
  if (!result.stdout) throw new Error("esbuild emitted no guest runtime asset");
  return result.stdout;
}
