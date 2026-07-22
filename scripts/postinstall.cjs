const path = require("path");
const { execSync } = require("child_process");
const { rebuild } = require("@electron/rebuild");
const { version: electronVersion } = require("electron/package.json");

const NATIVE_MODULES = ["node-pty", "win-job-object", "posix-pty-reaper"];

const buildPath = path.resolve(__dirname, "..");

async function runPostinstall() {
  const failures = [];

  // better-sqlite3 is intentionally NOT rebuilt: since v13 it is an N-API
  // addon loaded from the prebuilds/ binaries shipped inside the package.
  // N-API is ABI-stable, so the same prebuild works under Node and Electron,
  // and v13's binding.gyp suppresses source compilation while a prebuild
  // exists — a rebuild here would be a no-op that emits only gyp metadata.
  for (const mod of NATIVE_MODULES) {
    try {
      await rebuild({
        buildPath,
        electronVersion,
        onlyModules: [mod],
        force: true,
      });
    } catch (err) {
      failures.push({ module: mod, error: err });
    }
  }

  // Always run ConPTY asset fetch — it's idempotent, exits 0 on non-Windows,
  // and must not be skipped just because an unrelated native rebuild failed.
  // Using execSync (not require()) because the post-install script ends with
  // process.exit(0), which would override our process.exitCode.
  try {
    execSync("node node_modules/node-pty/scripts/post-install.js", {
      stdio: "inherit",
      cwd: buildPath,
    });
  } catch (err) {
    failures.push({ module: "node-pty post-install", error: err });
  }

  if (failures.length > 0) {
    console.error(`\nPostinstall failures (${failures.length}):`);
    for (const { module: mod, error } of failures) {
      console.error(`  ${mod}: ${error?.message ?? String(error)}`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runPostinstall();
}

module.exports = { runPostinstall };
