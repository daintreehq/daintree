/**
 * Vitest global setup — ensures better-sqlite3 is compiled for the
 * system Node.js rather than Electron's Node.js.
 *
 * The postinstall script rebuilds better-sqlite3 for Electron (different
 * NODE_MODULE_VERSION). This setup detects the mismatch and rebuilds for
 * system Node so tests that use it directly (e.g. TaskPersistence) work.
 * The teardown restores the Electron build so E2E tests still work.
 */

import { execSync } from "child_process";
import { createRequire } from "module";

let shouldRestoreElectronBuild = false;

export function setup(): void {
  const nativeRequire = createRequire(import.meta.url);
  try {
    // require() only loads the JS wrapper; instantiate to force-load the native addon
    const Database = nativeRequire("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    shouldRestoreElectronBuild = true;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("NODE_MODULE_VERSION") || message.includes("was compiled against")) {
      console.log("[vitest-setup] Rebuilding better-sqlite3 for system Node...");
      execSync("npm rebuild better-sqlite3 --silent", { stdio: "inherit" });
      shouldRestoreElectronBuild = true;
    }
  }
}

export function teardown(): void {
  if (shouldRestoreElectronBuild) {
    console.log("[vitest-teardown] Restoring better-sqlite3 for Electron...");
    execSync("npx electron-rebuild -f -w better-sqlite3 --silent", { stdio: "inherit" });
  }
}
