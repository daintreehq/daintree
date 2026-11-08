// macOS physical-footprint reader (#13526) and Main's dataless-file policy
// (#16361).
//
// Loads the compiled native addon on macOS and exposes an unavailable shim
// elsewhere. The native addon ships source-only — `electron-rebuild` compiles
// it during `postinstall` on macOS, and the binding.gyp target is empty on
// Windows / Linux, where resident memory already counts what matters.

"use strict";

let native = null;
let loadError = null;

if (process.platform === "darwin") {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    native = require("./build/Release/mac_phys_footprint.node");
  } catch (err) {
    loadError = err;
  }
}

/**
 * Physical footprint in bytes for each pid, positionally; null where a pid
 * could not be read. Returns null when the reader is unavailable in this
 * process, so callers can tell "no reading" from "nothing to read".
 */
function readPhysFootprints(pids) {
  if (!native || typeof native.readPhysFootprints !== "function") return null;
  if (!Array.isArray(pids)) return null;
  try {
    return native.readPhysFootprints(pids);
  } catch {
    return null;
  }
}

/**
 * Makes reads of online-only File Provider placeholders fail with EDEADLK
 * instead of blocking, on each of this process's libuv worker threads only, so
 * nothing it spawns inherits it. Resolves to { requested, applied, errors,
 * processPolicy }: `applied` distinct threads confirmed, an errno per refusal,
 * and the untouched process-wide policy children inherit. Returns null
 * when the addon is unavailable in this process.
 */
function disableThreadPoolDatalessMaterialization(threads, timeoutMs) {
  if (!native || typeof native.disableThreadPoolDatalessMaterialization !== "function") {
    return null;
  }
  try {
    return native.disableThreadPoolDatalessMaterialization(threads, timeoutMs);
  } catch {
    return null;
  }
}

function isAvailable() {
  return native !== null;
}

function getLoadError() {
  return loadError;
}

module.exports = {
  readPhysFootprints,
  disableThreadPoolDatalessMaterialization,
  isAvailable,
  getLoadError,
};
