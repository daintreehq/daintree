/**
 * Vitest global setup — ensures better-sqlite3 is compiled for the
 * system Node.js rather than Electron's Node.js.
 *
 * The postinstall script rebuilds better-sqlite3 for Electron (different
 * NODE_MODULE_VERSION). This setup detects the mismatch and rebuilds for
 * system Node so tests that use it directly (e.g. TaskPersistence) work.
 */

import { execSync } from "child_process";
import { createRequire } from "module";

export function setup(): void {
  const nativeRequire = createRequire(import.meta.url);
  try {
    // Force load the native addon — this will throw if compiled for wrong ABI
    nativeRequire("better-sqlite3");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("NODE_MODULE_VERSION") || message.includes("was compiled against")) {
      console.log("[vitest-setup] Rebuilding better-sqlite3 for system Node...");
      execSync("npm rebuild better-sqlite3 --silent", { stdio: "inherit" });
    }
  }
}
