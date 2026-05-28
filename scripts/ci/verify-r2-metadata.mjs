#!/usr/bin/env node
// Verifies that the update metadata YAML just uploaded to R2 is reachable at
// the public CDN edge URL and its content matches the local copy. Without this
// post-upload gate, a Cloudflare CDN edge node could serve a cached 404 for
// the metadata YAML even after the R2 PUT succeeds — see #9122.
//
// GETs the public metadata URL with exponential-backoff retry (5s / 10s / 20s),
// parses the remote YAML, and compares version, path, sha512, and files[]
// entries against the local copy. A mismatch or persistent 404 fails the
// publish so the release is not advertised to clients until the CDN is
// consistent.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as defaultSleep } from "node:timers/promises";
import { load } from "js-yaml";
import { buildPublishedUrl } from "./verify-r2-uploads.mjs";

const VALID_SUFFIXES = new Set(["-mac", "-linux", ""]);
const FETCH_TIMEOUT_MS = 15_000;

export function metadataFilename(prefix, suffix) {
  return `${prefix}${suffix}.yml`;
}

export function validateMetadataSuffix(suffix) {
  if (!VALID_SUFFIXES.has(suffix)) {
    const list = [...VALID_SUFFIXES].map((s) => (s === "" ? '""' : `"${s}"`)).join(", ");
    return {
      ok: false,
      error: `Invalid METADATA_SUFFIX "${suffix}". Expected one of: ${list}.`,
    };
  }
  return { ok: true };
}

export function loadLocalMetadata(releaseDir, filename) {
  const filePath = path.join(releaseDir, filename);
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`failed to read local metadata ${filePath}: ${err?.message ?? err}`);
  }
  let parsed;
  try {
    parsed = load(raw);
  } catch (err) {
    throw new Error(`failed to parse local metadata ${filePath}: ${err?.message ?? err}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`${filePath}: expected a YAML mapping`);
  }
  if (typeof parsed.version !== "string") {
    throw new Error(`${filePath}: missing or non-string 'version' field`);
  }
  if (typeof parsed.path !== "string") {
    throw new Error(`${filePath}: missing or non-string 'path' field`);
  }
  if (typeof parsed.sha512 !== "string") {
    throw new Error(`${filePath}: missing or non-string 'sha512' field`);
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(`${filePath}: 'files' is missing or empty`);
  }
  return parsed;
}

export async function fetchRemoteMetadata(url, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      const error = new Error(`network error fetching ${url}: ${cause}`);
      error.transient = true;
      throw error;
    }
    if (response.status !== 200) {
      const error = new Error(`expected HTTP 200 for ${url}, got ${response.status}`);
      error.transient = true;
      throw error;
    }
    let body;
    try {
      body = await response.text();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to read body from ${url}: ${cause}`);
    }
    let parsed;
    try {
      parsed = load(body);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to parse YAML from ${url}: ${cause}`);
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`${url}: expected a YAML mapping`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export function compareMetadata(local, remote) {
  if (local.version !== remote.version) {
    return `version mismatch: local=${local.version}, remote=${remote.version}`;
  }
  if (local.path !== remote.path) {
    return `path mismatch: local=${local.path}, remote=${remote.path}`;
  }
  if (local.sha512 !== remote.sha512) {
    return `sha512 mismatch for primary artifact (path=${local.path})`;
  }
  if (!Array.isArray(remote.files)) {
    return `remote files[] is not an array`;
  }
  if (local.files.length !== remote.files.length) {
    return `files[] length mismatch: local=${local.files.length}, remote=${remote.files.length}`;
  }
  for (let i = 0; i < local.files.length; i++) {
    const localFile = local.files[i];
    const remoteFile = remote.files[i];
    if (remoteFile === null || typeof remoteFile !== "object") {
      return `files[${i}]: remote entry is not an object`;
    }
    if (localFile.url !== remoteFile.url) {
      return `files[${i}].url mismatch: local=${localFile.url}, remote=${remoteFile.url}`;
    }
    if (localFile.sha512 !== remoteFile.sha512) {
      return `files[${i}].sha512 mismatch for ${localFile.url}`;
    }
  }
  const localDate =
    typeof local.releaseDate === "string" ? local.releaseDate : String(local.releaseDate);
  const remoteDate =
    typeof remote.releaseDate === "string" ? remote.releaseDate : String(remote.releaseDate);
  if (localDate !== remoteDate) {
    console.warn(
      `[verify-metadata] releaseDate differs (info only): local=${localDate}, remote=${remoteDate}`
    );
  }
  return null;
}

export async function verifyMetadataOnce(filename, publishUrl, releaseDir, fetchImpl = fetch) {
  let local;
  try {
    local = loadLocalMetadata(releaseDir, filename);
  } catch (err) {
    return { ok: false, error: err.message, transient: false };
  }
  const url = buildPublishedUrl(publishUrl, filename);
  let remote;
  try {
    remote = await fetchRemoteMetadata(url, fetchImpl);
  } catch (err) {
    return { ok: false, error: err.message, transient: err.transient === true };
  }
  const cmpErr = compareMetadata(local, remote);
  if (cmpErr) {
    return { ok: false, error: `content mismatch for ${url}: ${cmpErr}`, transient: false };
  }
  return { ok: true };
}

export async function verifyMetadataWithRetries({
  filename,
  publishUrl,
  releaseDir,
  fetch: fetchFn = fetch,
  sleep: sleepFn = defaultSleep,
  maxAttempts = 3,
  baseDelayMs = 5000,
  log = console.log,
}) {
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    return `maxAttempts must be >= 1, got ${maxAttempts}`;
  }
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await verifyMetadataOnce(filename, publishUrl, releaseDir, fetchFn);
    if (result.ok) {
      log(
        `[verify-metadata] ${buildPublishedUrl(publishUrl, filename)} verified (attempt ${attempt})`
      );
      return null;
    }
    lastError = result.error;
    if (!result.transient || attempt >= maxAttempts) {
      if (!result.transient) {
        log(`[verify-metadata] permanent error, not retrying: ${result.error}`);
      }
      break;
    }
    const delay = baseDelayMs * Math.pow(2, attempt - 1);
    log(
      `[verify-metadata] attempt ${attempt}/${maxAttempts} failed: ${result.error} — retrying in ${delay}ms`
    );
    await sleepFn(delay);
  }
  return lastError;
}

async function main() {
  const publishUrl = process.env.PUBLISH_URL;
  const releaseDir = process.env.RELEASE_DIR ?? "release";
  const prefix = process.env.UPDATE_METADATA_PREFIX;
  const suffix = process.env.METADATA_SUFFIX ?? "";

  if (!publishUrl) {
    console.error("::error::PUBLISH_URL env var is required");
    process.exit(1);
  }
  if (!prefix) {
    console.error("::error::UPDATE_METADATA_PREFIX env var is required");
    process.exit(1);
  }

  const suffixCheck = validateMetadataSuffix(suffix);
  if (!suffixCheck.ok) {
    console.error(`::error::${suffixCheck.error}`);
    process.exit(1);
  }

  const filename = metadataFilename(prefix, suffix);

  console.log(`[verify-metadata] checking ${buildPublishedUrl(publishUrl, filename)}`);

  const error = await verifyMetadataWithRetries({
    filename,
    publishUrl,
    releaseDir,
  });

  if (error) {
    console.error(`::error file=${filename}::${error}`);
    console.error(`[verify-metadata] metadata verification failed after retries`);
    process.exit(1);
  }

  console.log(`[verify-metadata] metadata verified reachable and correct`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
