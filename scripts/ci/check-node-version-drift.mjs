#!/usr/bin/env node
// Asserts the project's Node version stays aligned across the three
// machine-readable sources that declare it:
//   `.nvmrc`, `.node-version`, and `package.json`'s `engines.node`.
//
// These are separate files read by separate tools (nvm/fnm read `.nvmrc`,
// nodenv/asdf read `.node-version`, npm reads `engines.node`), so they can
// silently drift apart — which is exactly what happened in #11122, where a
// bump to 22.13.0 landed in `.nvmrc` and `engines.node` but never reached
// `.node-version`. This guard fails CI the moment they disagree.
//
// The engine range is the declared floor: both exact pins must EQUAL its
// minimum, not merely satisfy it — otherwise the two pins could drift upward
// together while `engines.node` stayed stale, and a range check would pass.
// `CONTRIBUTING.md` intentionally points at these files rather than repeating
// the number, so it is not a fourth source and is not checked here.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

const NVMRC = path.join(root, ".nvmrc");
const NODE_VERSION = path.join(root, ".node-version");
const PACKAGE_JSON = path.join(root, "package.json");

/**
 * Parse an exact Node version pin from a `.nvmrc` / `.node-version` file.
 * Accepts a single bare `x.y.z` with an optional leading `v` and surrounding
 * whitespace (a trailing newline is normal). Rejects ranges, aliases
 * (`lts/*`), inline comments, partial versions, multi-line content, a leading
 * byte-order mark, prereleases, build metadata (`22.13.0+local`), and a
 * double `v` — none of which are byte-portable across nvm/fnm/nodenv/asdf, and
 * all of which `semver` would otherwise normalize away and let two textually
 * different pins compare as equal, hiding the very drift this guards. Returns
 * the normalized `x.y.z` string; throws with `label` context on anything else.
 */
export function parseExactPin(raw, label) {
  if (raw.charCodeAt(0) === 0xfeff) {
    throw new Error(
      `${label}: starts with a byte-order mark — expected a bare ASCII version like "22.13.0"`
    );
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(`${label}: file is empty — expected an exact Node version like "22.13.0"`);
  }
  if (/\s/.test(trimmed)) {
    throw new Error(
      `${label}: expected a single bare version, got ${JSON.stringify(trimmed)} ` +
        `(no comments, aliases, or extra lines)`
    );
  }
  // Strict `x.y.z` grammar (optional lowercase `v`). Deliberately narrower than
  // `semver.valid`, which would accept a double `v`, build metadata, or a
  // prerelease and canonicalize them down to `x.y.z` — masking drift.
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(trimmed);
  const normalized = match && semver.valid(match[1]);
  if (!normalized) {
    throw new Error(
      `${label}: ${JSON.stringify(trimmed)} is not an exact x.y.z version ` +
        `(ranges, aliases like "lts/*", prereleases, and build metadata are not allowed)`
    );
  }
  return normalized;
}

/**
 * Parse `engines.node` out of package.json source text and derive its minimum
 * version via `semver.minVersion`, which correctly handles ranges like
 * `>=22.13.0`, `>=22.13.0 <23`, `^22.13.0`, and exclusive bounds (`>22.13.0`).
 * Throws on malformed JSON, a missing/non-string `engines.node`, an invalid
 * range, or a range no version can satisfy. Returns `{ range, minimum }`.
 */
export function parseNodeEngineRange(packageJsonText) {
  let pkg;
  try {
    pkg = JSON.parse(packageJsonText);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`package.json: not valid JSON (${cause})`);
  }
  const range = pkg?.engines?.node;
  if (typeof range !== "string" || range.trim() === "") {
    throw new Error(
      `package.json: engines.node must be a non-empty string, got ${JSON.stringify(range)}`
    );
  }
  if (!semver.validRange(range)) {
    throw new Error(
      `package.json: engines.node ${JSON.stringify(range)} is not a valid semver range`
    );
  }
  const minimum = semver.minVersion(range);
  if (!minimum) {
    throw new Error(
      `package.json: engines.node ${JSON.stringify(range)} has no satisfiable minimum version`
    );
  }
  return { range, minimum: minimum.version };
}

/**
 * Pure comparison of the parsed sources. Each exact pin must equal the engine
 * range's minimum; pin-vs-pin equality then follows transitively. Returns
 * `{ ok, failures }` where each failure names the offending file and reason.
 */
export function findNodeVersionDrift({
  nvmrcVersion,
  nodeVersionFile,
  engineRange,
  engineMinimum,
}) {
  const failures = [];
  const rangeDesc = `package.json engines.node ${JSON.stringify(engineRange)} (minimum ${engineMinimum})`;
  if (nvmrcVersion !== engineMinimum) {
    failures.push({
      file: NVMRC,
      message: `.nvmrc pins ${nvmrcVersion}, but ${rangeDesc} — they must declare the same version.`,
    });
  }
  if (nodeVersionFile !== engineMinimum) {
    failures.push({
      file: NODE_VERSION,
      message: `.node-version pins ${nodeVersionFile}, but ${rangeDesc} — they must declare the same version.`,
    });
  }
  return { ok: failures.length === 0, failures };
}

function readSource(file, label) {
  try {
    return { ok: true, text: readFileSync(file, "utf8") };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `${label}: could not read ${file} (${cause})` };
  }
}

function main() {
  let failures = 0;
  const emit = (file, message) => {
    console.error(`::error file=${file}::${message}`);
    failures++;
  };

  const nvmrcRead = readSource(NVMRC, ".nvmrc");
  const nodeVersionRead = readSource(NODE_VERSION, ".node-version");
  const pkgRead = readSource(PACKAGE_JSON, "package.json");

  let nvmrcVersion;
  let nodeVersionFile;
  let engine;

  if (!nvmrcRead.ok) {
    emit(NVMRC, nvmrcRead.error);
  } else {
    try {
      nvmrcVersion = parseExactPin(nvmrcRead.text, ".nvmrc");
    } catch (error) {
      emit(NVMRC, error.message);
    }
  }

  if (!nodeVersionRead.ok) {
    emit(NODE_VERSION, nodeVersionRead.error);
  } else {
    try {
      nodeVersionFile = parseExactPin(nodeVersionRead.text, ".node-version");
    } catch (error) {
      emit(NODE_VERSION, error.message);
    }
  }

  if (!pkgRead.ok) {
    emit(PACKAGE_JSON, pkgRead.error);
  } else {
    try {
      engine = parseNodeEngineRange(pkgRead.text);
    } catch (error) {
      emit(PACKAGE_JSON, error.message);
    }
  }

  // Only compare once every source parsed — otherwise a parse failure would
  // cascade into misleading "drift" errors against `undefined`.
  if (nvmrcVersion && nodeVersionFile && engine) {
    const { failures: drift } = findNodeVersionDrift({
      nvmrcVersion,
      nodeVersionFile,
      engineRange: engine.range,
      engineMinimum: engine.minimum,
    });
    for (const f of drift) {
      emit(f.file, f.message);
    }
  }

  if (failures > 0) {
    console.error(
      `\nNode version pins disagree: ${failures} issue(s). ` +
        `Align .nvmrc, .node-version, and package.json engines.node on the same version.`
    );
    process.exit(1);
  }

  console.log(
    `[check-node-version] OK — .nvmrc, .node-version, and engines.node all agree (${nvmrcVersion})`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
