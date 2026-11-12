#!/usr/bin/env node
// Verifies that a plugin list just uploaded to R2, the blocklist or the
// community catalog, is what the update host serves: HTTP 200, a JSON content
// type, and a body equal to the committed file. A successful PUT doesn't prove
// the CDN edge serves it (#9122). A kill-switch entry that never reaches
// clients fails silently, since the client treats a missing blocklist as
// "block nothing", and a catalog client treats a missing catalog as unpublished.
//
//   LIST_URL=<public url> LIST_FILE=<committed file> node scripts/ci/verify-plugin-list.mjs

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as defaultSleep } from "node:timers/promises";

const FETCH_TIMEOUT_MS = 15_000;

export function loadLocalList(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`failed to read ${filePath}: ${err?.message ?? err}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse ${filePath}: ${err?.message ?? err}`);
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error(`${filePath}: expected an object with an "entries" array`);
  }
  return parsed;
}

function transient(message) {
  const error = new Error(message);
  error.transient = true;
  return error;
}

export async function fetchRemoteList(url, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      throw transient(`network error fetching ${url}: ${err instanceof Error ? err.message : err}`);
    }
    if (response.status !== 200) {
      throw transient(`expected HTTP 200 for ${url}, got ${response.status}`);
    }
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new Error(`expected a JSON content type from ${url}, got "${contentType}"`);
    }
    let body;
    try {
      body = await response.text();
    } catch (err) {
      throw transient(
        `failed to read body from ${url}: ${err instanceof Error ? err.message : err}`
      );
    }
    try {
      return JSON.parse(body);
    } catch (err) {
      throw new Error(
        `failed to parse JSON from ${url}: ${err instanceof Error ? err.message : err}`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyListOnce(url, filePath, fetchImpl = fetch) {
  let local;
  try {
    local = loadLocalList(filePath);
  } catch (err) {
    return { ok: false, error: err.message, transient: false };
  }
  let remote;
  try {
    remote = await fetchRemoteList(url, fetchImpl);
  } catch (err) {
    return { ok: false, error: err.message, transient: err.transient === true };
  }
  if (!isDeepStrictEqual(local, remote)) {
    // An edge that still holds the previous list catches up, so a mismatch is
    // worth another look before it fails the publish.
    return { ok: false, error: `${url} does not match ${filePath}`, transient: true };
  }
  return { ok: true };
}

export async function verifyListWithRetries({
  url,
  filePath,
  fetch: fetchFn = fetch,
  sleep: sleepFn = defaultSleep,
  maxAttempts = 4,
  baseDelayMs = 5000,
  log = console.log,
}) {
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    return `maxAttempts must be >= 1, got ${maxAttempts}`;
  }
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await verifyListOnce(url, filePath, fetchFn);
    if (result.ok) {
      log(`[verify-plugin-list] ${url} verified (attempt ${attempt})`);
      return null;
    }
    lastError = result.error;
    if (!result.transient) {
      log(`[verify-plugin-list] permanent error, not retrying: ${result.error}`);
      break;
    }
    if (attempt >= maxAttempts) break;
    const delay = baseDelayMs * Math.pow(2, attempt - 1);
    log(
      `[verify-plugin-list] attempt ${attempt}/${maxAttempts} failed: ${result.error} — retrying in ${delay}ms`
    );
    await sleepFn(delay);
  }
  return lastError;
}

async function main() {
  const url = process.env.LIST_URL;
  const filePath = process.env.LIST_FILE;
  if (!url || !filePath) {
    console.error("::error::LIST_URL and LIST_FILE env vars are required");
    process.exit(1);
  }
  const error = await verifyListWithRetries({ url, filePath });
  if (error) {
    console.error(`::error file=${filePath}::${error}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
