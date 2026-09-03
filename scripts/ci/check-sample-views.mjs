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
 * only React): a bundled second copy throws "Invalid hook call" at first
 * render, and an *externalized* SDK specifier would silently stop proving the
 * package boundary, because the host import map does not serve it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");

/** Samples whose committed view bundle is regenerated and diffed. */
const SAMPLES = [
  {
    name: "file-tree",
    script: "build:sample-file-tree",
    artifact: "plugins/sample/file-tree/view/file-tree-view.js",
  },
];

/** Bare specifiers a view bundle may leave external — the host import map's set. */
const ALLOWED_EXTERNALS = new Set([
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
]);

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf-8", stdio: "pipe" });
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
      `${artifact} leaves "${specifier}" external. The host import map serves only React ` +
        `specifiers, so this would fail to resolve at load time — and an externalized ` +
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

for (const sample of SAMPLES) {
  // Captured before the rebuild, and compared after. Deliberately not a `git
  // diff`: that answers "does this differ from HEAD", which is empty for an
  // untracked artifact and noisy in any dirty tree. Comparing the bytes across
  // the rebuild answers the question actually being asked — was the artifact on
  // disk already what its source produces?
  const before = shouldCheck ? readArtifact(sample.artifact) : null;

  try {
    run("npm", ["run", sample.script]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${sample.name}: build failed — ${detail}`);
    continue;
  }

  auditExternals(sample.artifact);

  if (!shouldCheck) continue;

  const after = readArtifact(sample.artifact);
  if (before === null) {
    fail(`${sample.artifact} did not exist before the rebuild — commit the built artifact.`);
  } else if (before !== after) {
    fail(
      `${sample.artifact} was stale. Rebuilding it from \`renderer/\` produced a different file, ` +
        `so E2E was driving an artifact that no longer matches its source. The rebuilt file is now ` +
        `on disk — review and commit it.`
    );
  }
}

if (process.exitCode !== 1) {
  console.log(
    `[check-sample-views] OK — ${SAMPLES.length} sample view bundle(s) rebuilt clean with only React external`
  );
}
