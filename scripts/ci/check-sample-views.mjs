#!/usr/bin/env node
/**
 * Guards the committed sample-plugin view bundles against their source.
 *
 * The sample plugins ship pre-built `view/*.js` because `plugin://` loads
 * browser-ready ESM, and those artifacts are what E2E actually drives. Typecheck
 * meanwhile reads `renderer/*.tsx`. Left ungated, the two drift in both
 * directions: a source change leaves E2E exercising the previous
 * implementation, and a broken build path keeps passing because the last good
 * artifact is still committed.
 *
 * That drift is precisely the false-positive class the file-tree sample exists
 * to eliminate — a sample that no longer reflects its source proves nothing
 * about the published surface. So the build is re-run here and the tree must
 * come back clean.
 *
 * Also audits the artifact's imports. The bundle must externalize React (and
 * only what the host import map serves: React, the tour and plugin-ui): a
 * bundled second copy of React throws "Invalid hook call" at first render, and
 * an *externalized* SDK specifier would silently stop proving the package
 * boundary, because the host import map does not serve it.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");

/**
 * Samples whose committed build is regenerated and diffed: one view bundle, or
 * a whole output directory. The reference application is the second kind — it
 * is what `daintree-plugin new --project` copies, built, into a user's project,
 * so a stale `dist/` there ships stale code to every new app.
 */
const SAMPLES = [
  {
    name: "file-tree",
    script: "build:sample-file-tree",
    artifact: "plugins/sample/file-tree/view/file-tree-view.js",
  },
  {
    name: "acme.requests",
    script: "build:sample-reference-app",
    outDir: "plugins/sample-project/acme.requests/dist",
  },
];

/** Bare specifiers a view bundle may leave external — the host import map's set. */
const ALLOWED_EXTERNALS = new Set([
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "@daintreehq/tour",
  "@daintreehq/tour/react",
  "@daintreehq/tour/kit",
  "@daintreehq/tour/mock-app",
  "@daintreehq/plugin-ui",
]);

function run(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf-8",
    stdio: "pipe",
    // npm is exposed through npm.cmd on Windows. execFileSync does not launch
    // command shims through cmd.exe unless a shell is requested, so a direct
    // `npm` lookup reports ENOENT even though setup-node installed it.
    shell: process.platform === "win32",
  });
}

function fail(message) {
  console.error(`[check-sample-views] ${message}`);
  process.exitCode = 1;
}

function auditExternals(artifact) {
  const source = readFileSync(path.join(root, artifact), "utf-8");
  // Static `import ... from "x"` and bare `import "x"` at the top level. A
  // relative or absolute specifier is inlined output, not an external.
  const specifiers = new Set();
  for (const match of source.matchAll(/^import\s[^;]*?from\s*["']([^"']+)["']/gm)) {
    specifiers.add(match[1]);
  }
  for (const match of source.matchAll(/^import\s*["']([^"']+)["']/gm)) {
    specifiers.add(match[1]);
  }

  for (const specifier of specifiers) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (ALLOWED_EXTERNALS.has(specifier)) continue;
    fail(
      `${artifact} leaves "${specifier}" external. The host import map serves only React, ` +
        `@daintreehq/tour and @daintreehq/plugin-ui specifiers, so this would fail to resolve at load time — and an externalized ` +
        `@daintreehq/* specifier would also stop the sample proving the package boundary.`
    );
  }
}

const shouldCheck = process.argv.includes("--check");

function readArtifact(artifact) {
  try {
    return readFileSync(path.join(root, artifact), "utf-8");
  } catch {
    return null;
  }
}

/** Every file under `dir`, by path relative to the repository root. */
function listFiles(dir) {
  try {
    return readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .sort();
  } catch {
    return [];
  }
}

/** The sample's committed output: its one bundle, or every file in its outDir. */
function snapshot(sample) {
  const files = sample.outDir ? listFiles(sample.outDir) : [sample.artifact];
  return new Map(files.map((file) => [file, readArtifact(file)]));
}

for (const sample of SAMPLES) {
  // Captured before the rebuild, and compared after. Deliberately not a `git
  // diff`: that answers "does this differ from HEAD", which is empty for an
  // untracked artifact and noisy in any dirty tree. Comparing the bytes across
  // the rebuild answers the question actually being asked — was the artifact on
  // disk already what its source produces?
  const before = shouldCheck ? snapshot(sample) : null;

  try {
    run("npm", ["run", sample.script]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${sample.name}: build failed — ${detail}`);
    continue;
  }

  const after = snapshot(sample);
  for (const file of after.keys()) {
    if (file.endsWith(".js")) auditExternals(file);
  }

  if (!shouldCheck) continue;

  for (const [file, content] of after) {
    const committed = before.get(file);
    if (committed === undefined || committed === null) {
      fail(`${file} did not exist before the rebuild — commit the built artifact.`);
    } else if (committed !== content) {
      fail(
        `${file} was stale. Rebuilding ${sample.name} from source produced a different file, ` +
          `so what ships no longer matches its source. The rebuilt file is now on disk — review and commit it.`
      );
    }
  }
  for (const file of before.keys()) {
    if (!after.has(file)) {
      fail(`${file} is committed but the build no longer produces it — delete it.`);
    }
  }
}

if (process.exitCode !== 1) {
  console.log(
    `[check-sample-views] OK — ${SAMPLES.length} sample view bundle(s) rebuilt clean with only host import-map specifiers external`
  );
}
