const { execSync } = require("child_process");

// `win-job-object` is a Windows-only N-API addon (#7526). Its binding.gyp
// emits zero sources on macOS / Linux (the target has empty sources list),
// so node-gyp skips it with a SKIPPED message — the wrapper handles the
// missing-binary case gracefully.
//
// `posix-pty-reaper` is the inverse (#8769): a macOS / Linux executable whose
// binding.gyp emits `type: none` on Windows, so it's a no-op there and the
// wrapper reports unavailable.
execSync("electron-rebuild -f -w node-pty,better-sqlite3,win-job-object,posix-pty-reaper", {
  stdio: "inherit",
});
require("../node_modules/node-pty/scripts/post-install.js");
