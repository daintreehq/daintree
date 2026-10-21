// macOS physical-footprint reader wrapper (#13526).
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

function isAvailable() {
  return native !== null;
}

function getLoadError() {
  return loadError;
}

module.exports = {
  readPhysFootprints,
  isAvailable,
  getLoadError,
};
