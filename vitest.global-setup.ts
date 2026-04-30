/**
 * Vitest global setup — ensures better-sqlite3 is compiled for the
 * system Node.js rather than Electron's Node.js.
 *
 * The postinstall script rebuilds better-sqlite3 for Electron (different
 * NODE_MODULE_VERSION). This setup detects the mismatch and rebuilds for
 * system Node so tests that use it directly (e.g. TaskPersistence) work.
 * The teardown restores the Electron build so E2E tests still work.
 *
 * The ABI check runs in a child process so the native addon is never loaded
 * into the main vitest process. Loading it here causes a segfault (exit 139)
 * on Linux when vitest exits — the addon's finalizers crash during cleanup.
 */

import { execSync, spawnSync } from "child_process";

let shouldRestoreElectronBuild = false;

export function setup(): void {
  const probe = spawnSync(
    process.execPath,
    ["-e", "const D = require('better-sqlite3'); const db = new D(':memory:'); db.close();"],
    { encoding: "utf8" }
  );

  if (probe.status === 0) {
    shouldRestoreElectronBuild = true;
    return;
  }

  const message = `${probe.stderr ?? ""}${probe.stdout ?? ""}`;
  if (message.includes("NODE_MODULE_VERSION") || message.includes("was compiled against")) {
    console.log("[vitest-setup] Rebuilding better-sqlite3 for system Node...");
    execSync("npm rebuild better-sqlite3 --silent", { stdio: "inherit" });
    shouldRestoreElectronBuild = true;
  }
}

export function teardown(): void {
  if (!shouldRestoreElectronBuild) return;
  // Skip in CI: each job runs `npm ci` which rebuilds for Electron via postinstall,
  // so restoring here is redundant. Worse, replacing the .node file on disk while
  // the same addon is loaded into a sibling process can race with finalizers.
  if (process.env.CI) return;
  console.log("[vitest-teardown] Restoring better-sqlite3 for Electron...");
  execSync("npx electron-rebuild -f -w better-sqlite3 --silent", { stdio: "inherit" });
}
