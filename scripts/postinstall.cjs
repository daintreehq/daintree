const path = require("path");
const { execSync, spawnSync } = require("child_process");
const { rebuild } = require("@electron/rebuild");
const { version: electronVersion } = require("electron/package.json");

const NATIVE_MODULES = ["node-pty", "win-job-object", "posix-pty-reaper"];

const buildPath = path.resolve(__dirname, "..");

async function runPostinstall() {
  const failures = [];

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

  // better-sqlite3 is not in NATIVE_MODULES — it ships prebuilt binaries via
  // prebuild-install. When npm_config_runtime=electron + npm_config_target are
  // set (CI e2e/release), prebuild-install downloads the correct Electron-ABI
  // binary and the probe below exits 1 (NODE_MODULE_VERSION mismatch under
  // Node), so we skip the rebuild. Without those env vars (local dev, CI
  // check/test), prebuild-install defaults to Node ABI, the probe exits 0, and
  // we rebuild here.
  const betterSqliteBinary = path.join(
    buildPath,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node"
  );
  try {
    const probe = spawnSync(
      process.execPath,
      [
        "-e",
        "const m={exports:{}};try{process.dlopen(m,process.argv[1]);process.exit(0)}catch(e){if(e.message.includes('NODE_MODULE_VERSION')||e.message.includes('was compiled against'))process.exit(1);throw e}",
        betterSqliteBinary,
      ],
      { encoding: "utf8", timeout: 5000 }
    );

    if (probe.status === 0) {
      console.log("[postinstall] better-sqlite3 has Node ABI, rebuilding for Electron...");
      await rebuild({
        buildPath,
        electronVersion,
        onlyModules: ["better-sqlite3"],
        force: true,
      });
      console.log("[postinstall] better-sqlite3 rebuilt for Electron ABI");
    } else if (probe.status === 1) {
      console.log("[postinstall] better-sqlite3 already has Electron ABI, skipping rebuild");
    } else {
      failures.push({
        module: "better-sqlite3",
        error: new Error(`ABI probe failed: ${probe.stderr || probe.stdout || "unknown error"}`),
      });
    }
  } catch (err) {
    failures.push({ module: "better-sqlite3", error: err });
  }

  if (failures.length > 0) {
    console.error(`\nRebuild failures (${failures.length}/${NATIVE_MODULES.length + 2}):`);
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
