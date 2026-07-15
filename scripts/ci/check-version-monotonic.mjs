#!/usr/bin/env node
// Blocks the release publish if the new version isn't strictly greater than the
// version currently advertised on the live update feed. electron-updater on
// stable runs with `allowDowngrade = false` (see electron/services/AutoUpdaterService.ts),
// so a regressed `latest-mac.yml` / `latest-linux.yml` permanently strands every
// installed client until a hand-rolled republish — see #7573.
//
// Reads the new version from the local artifacts already downloaded into
// `release/${UPDATE_METADATA_PREFIX}{,-mac,-linux}.yml` (Windows uses the
// no-suffix file), fetches the same files from
// https://updates.daintree.org/releases/, and compares with `semver.gt`.
// Equal versions are treated as "already published" — the gate passes without
// re-uploading (a re-tag of a version already live shouldn't red-build or
// rewrite the artifacts already serving clients); see #11185.
//
// Outcomes (per platform):
//   - new > live                   -> OK, upload proceeds
//   - new == live                  -> skip (already published; no re-upload)
//   - new < live                   -> fail closed (a downgrade would strand clients)
//   - 404 on the live feed         -> pass for that platform (first release in channel)
//   - any other HTTP / network err -> fail closed
//   - YAML parse / missing version -> fail closed
//   - mac and linux disagree on    -> fail closed (split-brain build)
//     the new version
//
// When every checked platform resolves to "already live", the script writes
// `skip_upload=true` to $GITHUB_OUTPUT so the composite action skips the R2
// upload and verify steps for this run (see .github/actions/publish-daintree).

import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "js-yaml";
import semver from "semver";

const FEED_BASE_URL = "https://updates.daintree.org/releases";
const FETCH_TIMEOUT_MS = 15_000;
const PLATFORMS = ["mac", "linux", "win"];

/**
 * Map a platform identifier to the metadata filename electron-updater actually
 * fetches. Windows is the historical odd-one-out: clients poll `<prefix>.yml`
 * with no `-win` suffix (electron-updater Provider.getChannelFilePrefix()
 * returns "" for win32). Using the wrong filename here means the gate checks
 * a file no real client downloads.
 */
function platformFilename(prefix, platform) {
  if (platform === "win") return `${prefix}.yml`;
  return `${prefix}-${platform}.yml`;
}
const ALLOWED_PREFIXES = ["latest", "rc", "beta"];

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

export function extractVersion(parsed, label) {
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${label}: expected a YAML mapping with a 'version' field`);
  }
  const raw = parsed.version;
  if (raw === undefined || raw === null) {
    throw new Error(`${label}: missing 'version' field`);
  }
  if (typeof raw !== "string") {
    // YAML parses bare numerics (`version: 1`) as JS numbers — reject so a
    // bad metadata file can't slip past `semver.valid` after coercion.
    throw new Error(
      `${label}: 'version' must be a string, got ${typeof raw} (${JSON.stringify(raw)})`
    );
  }
  if (!semver.valid(raw)) {
    throw new Error(`${label}: '${raw}' is not a valid semver version`);
  }
  return raw;
}

/**
 * Resolve which platforms this gate run should check. Per-OS release
 * workflows (#8052) each publish only their own platform's metadata, so the
 * gate must scope to just that platform — checking `mac` from the Windows
 * workflow would fail on a missing local artifact. `RELEASE_PLATFORMS` is a
 * comma-separated subset of PLATFORMS; unset means "all" (the historical
 * single-workflow behavior, still used by tests and any caller that downloads
 * every platform's artifacts). Per-platform monotonicity is the only
 * invariant electron-updater actually cares about — cross-OS version
 * alignment was never a real constraint, so narrowing the scope is strictly
 * more correct, not a weakening.
 */
export function resolvePlatforms(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return { ok: true, platforms: [...PLATFORMS] };
  }
  const requested = String(raw)
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (requested.length === 0) {
    return { ok: true, platforms: [...PLATFORMS] };
  }
  const unknown = requested.filter((p) => !PLATFORMS.includes(p));
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `RELEASE_PLATFORMS contains unknown platform(s): ${unknown.join(", ")}. ` +
        `Expected a comma-separated subset of: ${PLATFORMS.join(", ")}.`,
    };
  }
  // Preserve PLATFORMS order and dedupe so downstream index-based reporting
  // stays stable regardless of how the env var was written.
  return { ok: true, platforms: PLATFORMS.filter((p) => requested.includes(p)) };
}

export function validatePrefix(prefix) {
  if (!prefix) {
    return {
      ok: false,
      error:
        "UPDATE_METADATA_PREFIX env var is not set — refusing to guess the channel. " +
        `Set it to one of: ${ALLOWED_PREFIXES.join(", ")}.`,
    };
  }
  if (!ALLOWED_PREFIXES.includes(prefix)) {
    return {
      ok: false,
      error:
        `UPDATE_METADATA_PREFIX='${prefix}' is not a known channel. ` +
        `Expected one of: ${ALLOWED_PREFIXES.join(", ")}.`,
    };
  }
  return { ok: true };
}

export function checkVersionMonotonic(liveVersion, newVersion) {
  if (!semver.valid(liveVersion)) {
    return { ok: false, error: `live version '${liveVersion}' is not valid semver` };
  }
  if (!semver.valid(newVersion)) {
    return { ok: false, error: `new version '${newVersion}' is not valid semver` };
  }
  // An identical version string is not a regression — it's a re-tag of a
  // version that already published successfully. Signal "skip" so the caller
  // uploads nothing rather than failing (the old behavior) or rewriting the
  // live artifacts. Use exact identity, not semver.eq: build-metadata- or
  // format-only variants (e.g. 1.0.0+a vs 1.0.0+b, or v1.0.0 vs 1.0.0) share
  // updater precedence but were never actually the published version, so they
  // fall through to the strict-greater check and fail closed. A genuine re-tag
  // always produces a byte-identical version string (same package.json version).
  if (newVersion === liveVersion) {
    return { ok: true, skip: true };
  }
  if (!semver.gt(newVersion, liveVersion)) {
    return {
      ok: false,
      error: `new version ${newVersion} is not strictly greater than live ${liveVersion}`,
    };
  }
  return { ok: true };
}

/**
 * Aggregate the per-platform outcomes into the single `skip_upload` boolean the
 * composite action gates its R2 upload/verify steps on. Skipping is only safe
 * when *every* checked platform is already live and nothing failed — the upload
 * steps `aws s3 sync` the whole `release/` dir, so a partial skip isn't
 * expressible at the file level. Production invokes this gate one platform at a
 * time (release-{macos,linux,windows}.yml), so this AND is unambiguous there;
 * the aggregate only matters for a hypothetical caller that scopes several
 * platforms at once.
 */
export function shouldSkipUpload(platforms, skippedPlatforms, failures) {
  return (
    platforms.length > 0 &&
    failures.length === 0 &&
    skippedPlatforms.length === platforms.length
  );
}

async function fetchLiveVersion(prefix, platform) {
  const url = `${FEED_BASE_URL}/${platformFilename(prefix, platform)}`;
  const controller = new AbortController();
  // Keep the abort signal armed across both the headers fetch and the body
  // read — a CDN that returns 200 then stalls the body would otherwise hang
  // until the job-level 15min timeout instead of failing closed at 15s.
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { "cache-control": "no-cache" },
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to fetch ${url}: ${cause}`);
    }

    if (response.status === 404) {
      return { url, status: 404, version: null };
    }
    if (!response.ok) {
      throw new Error(`unexpected HTTP ${response.status} from ${url}`);
    }
    let body;
    try {
      body = await response.text();
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to read body from ${url}: ${cause}`);
    }
    let parsed;
    try {
      parsed = load(body);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse YAML from ${url}: ${cause}`);
    }
    const version = extractVersion(parsed, `live ${prefix}-${platform}.yml`);
    return { url, status: response.status, version };
  } finally {
    clearTimeout(timer);
  }
}

async function readLocalVersion(releaseDir, prefix, platform) {
  const filePath = path.join(releaseDir, platformFilename(prefix, platform));
  let body;
  try {
    body = await readFile(filePath, "utf8");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read local artifact ${filePath}: ${cause}`);
  }
  let parsed;
  try {
    parsed = load(body);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse YAML from ${filePath}: ${cause}`);
  }
  return { filePath, version: extractVersion(parsed, `local ${prefix}-${platform}.yml`) };
}

async function main() {
  const prefix = process.env.UPDATE_METADATA_PREFIX;
  // A typo like "latset" would otherwise make every live URL 404, which the
  // gate treats as "first release in channel" and silently passes — exactly
  // the regression we're trying to prevent.
  const prefixCheck = validatePrefix(prefix);
  if (!prefixCheck.ok) {
    fail(prefixCheck.error);
  }

  const platformsCheck = resolvePlatforms(process.env.RELEASE_PLATFORMS);
  if (!platformsCheck.ok) {
    fail(platformsCheck.error);
  }
  const platforms = platformsCheck.platforms;
  if (platforms.length < PLATFORMS.length) {
    console.log(`[monotonic] scoped to platform(s): ${platforms.join(", ")}`);
  }

  const releaseDir = process.env.RELEASE_DIR ?? "release";

  let locals;
  try {
    locals = await Promise.all(
      platforms.map((platform) => readLocalVersion(releaseDir, prefix, platform))
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const newVersion = locals[0].version;
  const mismatches = locals.filter((entry) => entry.version !== newVersion);
  if (mismatches.length > 0) {
    const summary = locals
      .map((entry, idx) => `${platforms[idx]}=${entry.version} (${entry.filePath})`)
      .join(" ");
    fail(
      `platform artifacts disagree on the new version: ${summary} — ` +
        `something went wrong in the matrix build.`
    );
  }

  // Fetch every channel feed in parallel so a transient mac error and a real
  // linux regression both surface in the same `::error::` annotation block,
  // rather than fail-fast hiding the second issue until the first is rerun.
  const fetchResults = await Promise.allSettled(
    platforms.map((platform) => fetchLiveVersion(prefix, platform))
  );

  const failures = [];
  const skippedPlatforms = [];
  for (let i = 0; i < platforms.length; i++) {
    const platform = platforms[i];
    const settled = fetchResults[i];
    if (settled.status === "rejected") {
      const reason = settled.reason;
      failures.push(`${platform}: ${reason instanceof Error ? reason.message : String(reason)}`);
      continue;
    }
    const live = settled.value;
    if (live.version === null) {
      console.log(
        `[monotonic] ${platform}: no live ${platformFilename(prefix, platform)} (HTTP 404) — first release in channel, allowing.`
      );
      continue;
    }
    const result = checkVersionMonotonic(live.version, newVersion);
    if (!result.ok) {
      failures.push(`${platform}: ${result.error} (feed: ${live.url})`);
    } else if (result.skip) {
      skippedPlatforms.push(platform);
      console.log(
        `[monotonic] ${platform}: ${newVersion} is already live (${live.url}) — already published, skipping re-upload for this platform.`
      );
    } else {
      console.log(
        `[monotonic] ${platform}: ${newVersion} > ${live.version} (live ${live.url}) — OK.`
      );
    }
  }

  if (failures.length > 0) {
    fail(`version-monotonic gate failed:\n  - ${failures.join("\n  - ")}`);
  }

  const skipUpload = shouldSkipUpload(platforms, skippedPlatforms, failures);
  writeSkipUploadOutput(skipUpload);

  if (skipUpload) {
    console.log(
      `[monotonic] channel '${prefix}': version ${newVersion} is already live on every checked platform — skipping re-upload for this run.`
    );
  } else {
    const uploadCount = platforms.length - skippedPlatforms.length;
    console.log(
      `[monotonic] gate passed for channel '${prefix}': new version ${newVersion} cleared the monotonic check; upload enabled for ${uploadCount} platform(s).`
    );
  }
}

/**
 * Communicate the skip decision to the composite action via $GITHUB_OUTPUT so
 * later steps can gate on `steps.<id>.outputs.skip_upload`. No-op when the env
 * var is unset (local runs / vitest self-execution). We deliberately do NOT
 * swallow a write error: if the runner set GITHUB_OUTPUT but the append fails,
 * the skip decision can't be communicated and the gate should fail closed.
 */
export function writeSkipUploadOutput(skipUpload) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `skip_upload=${skipUpload}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

// Re-export for tests that want the shared constants without hardcoding values.
export { FEED_BASE_URL, PLATFORMS, ALLOWED_PREFIXES };
