const path = require("path");
const { execSync } = require("child_process");
const { rebuild } = require("@electron/rebuild");
const { version: electronVersion } = require("electron/package.json");

const NATIVE_MODULES = ["node-pty", "win-job-object", "posix-pty-reaper"];

const buildPath = path.resolve(__dirname, "..");

async function runPostinstall() {
  const failures = [];

  // Apply package patches before any native rebuild. better-sqlite3 needs
  // patches/better-sqlite3+12.10.0.patch (upstream WiseLibs/better-sqlite3#1475)
  // to compile against Electron 42's V8 14.8 — the patch is NODE_MODULE_VERSION
  // gated, so it's a no-op on the Node ABI and only changes the Electron build.
  // It MUST run before @electron/rebuild compiles better-sqlite3 from source, or
  // the V8 14.8 build fails with an opaque compile error. Invoked via node (not
  // npx) for determinism and to match the node-pty post-install pattern below.
  // --error-on-fail forces a non-zero exit when a patch doesn't apply even off
  // CI (patch-package otherwise only fails hard under CI/test), so the
  // patchFailed gate below is reliable on local dev too.
  let patchFailed = false;
  try {
    execSync("node node_modules/patch-package/index.js --error-on-fail", {
      stdio: "inherit",
      cwd: buildPath,
    });
  } catch (err) {
    patchFailed = true;
    failures.push({ module: "patch-package", error: err });
  }

  // better-sqlite3 is rebuilt from source against the Electron ABI alongside the
  // other native modules. It previously skipped the rebuild via a dlopen ABI
  // probe (load the binary under Node: success → Node ABI, rebuild; throw →
  // Electron ABI, skip). That heuristic is dropped here — always rebuilding from
  // source after patching guarantees the Electron ABI without depending on which
  // binary prebuild-install fetched or on the CI runtime env vars, removing a
  // fragile path for a ~30s build cost. It's gated on the patch succeeding —
  // without the patch, the V8 14.8 build fails with an opaque compile error that
  // would mask the real cause.
  const rebuildModules = patchFailed ? NATIVE_MODULES : [...NATIVE_MODULES, "better-sqlite3"];

  for (const mod of rebuildModules) {
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
