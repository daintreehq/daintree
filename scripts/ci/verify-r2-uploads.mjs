#!/usr/bin/env node
// Verifies that every binary referenced in the generated update metadata
// (release/<prefix>{,-mac,-linux,-linux-arm64}.yml — Windows uses the no-suffix file)
// is reachable at the public CDN URL with a matching Content-Length before
// the metadata files are uploaded.
//
// Without this gap check, a CDN propagation race or a partial binary upload
// would publish update metadata pointing at a 404 or a truncated artifact.
// electron-updater fails silently in that case and users sit on the previous
// version until the next poll catches a corrected publish.

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as defaultSleep } from "node:timers/promises";
import { load } from "js-yaml";

export function buildPublishedUrl(baseUrl, filename) {
  if (!baseUrl) throw new Error("baseUrl is required");
  if (!filename) throw new Error("filename is required");
  if (/^https?:\/\//i.test(filename)) return filename;
  const trimmed = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${trimmed}${filename}`;
}

export async function verifyFileUrl(entry, { fetch: fetchFn, publishUrl }) {
  const url = buildPublishedUrl(publishUrl, entry.url);
  let response;
  try {
    response = await fetchFn(url, { method: "HEAD", redirect: "follow" });
  } catch (err) {
    return `network error fetching ${url}: ${err?.message ?? err}`;
  }
  if (response.status !== 200) {
    return `expected HTTP 200 for ${url}, got ${response.status}`;
  }
  const contentLengthRaw = response.headers.get("content-length");
  if (contentLengthRaw == null) {
    return `missing Content-Length header for ${url}`;
  }
  const contentLength = Number(contentLengthRaw);
  if (!Number.isFinite(contentLength)) {
    return `invalid Content-Length "${contentLengthRaw}" for ${url}`;
  }
  if (contentLength !== entry.size) {
    return `Content-Length mismatch for ${url}: expected ${entry.size}, got ${contentLength}`;
  }
  return null;
}

export async function verifyWithRetries(
  entry,
  {
    fetch: fetchFn,
    publishUrl,
    sleep: sleepFn = defaultSleep,
    maxAttempts = 3,
    baseDelayMs = 5000,
  } = {}
) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const error = await verifyFileUrl(entry, { fetch: fetchFn, publishUrl });
    if (!error) return null;
    lastError = error;
    if (attempt < maxAttempts) {
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await sleepFn(delay);
    }
  }
  return lastError;
}

// electron-updater on Windows polls `<prefix>.yml` (no platform suffix),
// while mac/linux use `<prefix>-<platform>.yml`. Both layouts coexist in
// `release/` after a full matrix build.
const METADATA_PATTERNS = [
  (prefix) => `${prefix}-mac.yml`,
  (prefix) => `${prefix}-linux.yml`,
  (prefix) => `${prefix}-linux-arm64.yml`,
  (prefix) => `${prefix}.yml`,
];

export async function findMetadataFiles(releaseDir, prefix) {
  const entries = await readdir(releaseDir);
  const found = [];
  for (const pattern of METADATA_PATTERNS) {
    const target = pattern(prefix);
    if (entries.includes(target)) {
      found.push(path.join(releaseDir, target));
    }
  }
  return found;
}

export function loadMetadata(filePath) {
  return load(readFileSync(filePath, "utf8"));
}

export async function verifyAllFiles({
  metadataFiles,
  publishUrl,
  fetch: fetchFn = fetch,
  sleep: sleepFn = defaultSleep,
  maxAttempts,
  baseDelayMs,
  log = console.log,
}) {
  const failures = [];
  for (const filePath of metadataFiles) {
    let data;
    try {
      data = loadMetadata(filePath);
    } catch (err) {
      failures.push({
        filePath,
        message: `failed to read or parse metadata: ${err?.message ?? err}`,
      });
      continue;
    }
    if (!Array.isArray(data?.files) || data.files.length === 0) {
      failures.push({ filePath, message: "files[] missing or empty" });
      continue;
    }
    for (const entry of data.files) {
      if (!entry?.url || !Number.isFinite(entry?.size)) {
        failures.push({
          filePath,
          message: `invalid file entry in metadata: ${JSON.stringify(entry)}`,
        });
        continue;
      }
      const error = await verifyWithRetries(entry, {
        fetch: fetchFn,
        publishUrl,
        sleep: sleepFn,
        maxAttempts,
        baseDelayMs,
      });
      if (error) {
        failures.push({ filePath, message: error });
      } else {
        log(`[verify] ok ${buildPublishedUrl(publishUrl, entry.url)} (${entry.size} bytes)`);
      }
    }
  }
  return failures;
}

async function main() {
  const publishUrl = process.env.PUBLISH_URL ?? process.argv[2];
  const releaseDir = process.env.RELEASE_DIR ?? process.argv[3] ?? "release";
  const prefix = process.env.UPDATE_METADATA_PREFIX ?? process.argv[4] ?? "latest";

  if (!publishUrl) {
    console.error("::error::PUBLISH_URL env var (or first CLI arg) is required");
    process.exit(1);
  }

  const metadataFiles = await findMetadataFiles(releaseDir, prefix);
  if (metadataFiles.length === 0) {
    console.error(
      `::error::No update metadata files found in ${releaseDir} matching ${prefix}{,-mac,-linux,-linux-arm64}.yml`
    );
    process.exit(1);
  }

  console.log(`[verify] PUBLISH_URL=${publishUrl}`);
  console.log(
    `[verify] checking ${metadataFiles.length} metadata file(s): ${metadataFiles.join(", ")}`
  );

  const failures = await verifyAllFiles({
    metadataFiles,
    publishUrl,
  });

  if (failures.length > 0) {
    for (const { filePath, message } of failures) {
      console.error(`::error file=${filePath}::${message}`);
    }
    console.error(`[verify] ${failures.length} binary URL(s) failed verification`);
    process.exit(1);
  }

  console.log(`[verify] all binaries verified reachable`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
