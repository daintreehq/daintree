import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const buildScript = pathToFileURL(path.join(repoRoot, "scripts/build-main.mjs")).href;

/**
 * Builds every core picker asset with the configuration `scripts/build-main.mjs`
 * itself uses, so these tests run the bundles the app ships rather than a copy
 * of them. `extra` adds test-only entries (repo-relative), built the same way.
 *
 * Out of process because suites that run under jsdom cannot load esbuild at
 * all: jsdom's `TextEncoder` fails its startup invariant.
 */
export function buildCoreGuestAssets(
  extra: Array<{ id: string; entry: string }> = []
): Record<string, string> {
  const script = [
    'const esbuild = require("esbuild");',
    `import(${JSON.stringify(buildScript)})`,
    "  .then(async (m) => {",
    `    const assets = [...m.CORE_PICKER_GUEST_ASSETS, ...${JSON.stringify(extra)}];`,
    "    const out = {};",
    "    for (const asset of assets) {",
    "      const result = await esbuild.build({",
    '        ...m.guestRuntimeBuildConfig({ ...asset, outfile: "out/" + asset.id.replace(/[^a-z0-9-]/gi, "-") + ".js" }, {',
    `          absWorkingDir: ${JSON.stringify(repoRoot)},`,
    "        }),",
    "        write: false,",
    '        logLevel: "silent",',
    "      });",
    "      out[asset.id] = result.outputFiles[0].text;",
    "    }",
    "    process.stdout.write(JSON.stringify(out));",
    "  })",
    "  .catch((err) => { console.error(err); process.exit(1); });",
  ].join("\n");

  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`core guest asset build failed: ${result.stderr || result.error?.message}`);
  }
  return JSON.parse(result.stdout) as Record<string, string>;
}
