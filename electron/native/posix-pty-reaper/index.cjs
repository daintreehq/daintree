// POSIX help-session PTY supervisor wrapper (#8769).
//
// Resolves the path to the compiled `daintree_pty_supervisor` executable on
// macOS / Linux and reports availability. The binary ships source-only —
// `electron-rebuild` compiles it during `postinstall` (its binding.gyp emits an
// executable target on non-Windows, and `type: none` on Windows). On Windows
// this wrapper reports unavailable; crash-safe reaping there is handled by
// win-job-object (#7526).

"use strict";

const path = require("path");
const fs = require("fs");

const SUPPORTED = process.platform === "darwin" || process.platform === "linux";

function getSupervisorPath() {
  if (!SUPPORTED) return null;
  return path.join(__dirname, "build", "Release", "daintree_pty_supervisor");
}

function isAvailable() {
  const p = getSupervisorPath();
  if (!p) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  getSupervisorPath,
  isAvailable,
};
