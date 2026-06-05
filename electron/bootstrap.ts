// Environment setup must run before anything that reads `app.getPath("userData")`
// — in dev mode it calls `app.setPath("userData", "daintree-dev")` so the dev
// instance doesn't collide with the production app. Importing it here ensures
// runBootMigrations, the compile-cache dir, and initializeStore all resolve to
// the correct directory before main.ts re-imports it (idempotent via ESM cache).
import "./setup/environment.js";

import { enableCompileCache, flushCompileCache, constants as moduleConstants } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { app, dialog } from "electron";
import { runBootMigrations } from "./boot/migrations/index.js";
import { isSafeModeActive } from "./services/CrashLoopGuardService.js";
import { setCompileCacheEnableStatus } from "./utils/hostPerformance.js";
import { initializeStore, _peekStoreInstance } from "./store.js";
import { formatErrorMessage } from "../shared/utils/errorMessage.js";

const cacheDir = path.join(app.getPath("userData"), "compile-cache");
{
  // Capture the enableCompileCache() status. It's the only runtime signal that
  // the cache is actually active — status FAILED means the directory is
  // unusable and the app silently runs without caching. We stash it so the
  // APP_BOOT_START mark can surface it (see getCompileCacheMeta).
  let result: ReturnType<typeof enableCompileCache> | undefined;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    result = enableCompileCache(cacheDir);
  } catch {
    try {
      result = enableCompileCache();
    } catch {
      // enableCompileCache is best-effort; the app boots fine without it.
    }
  }
  if (result) {
    setCompileCacheEnableStatus(result.status);
    if (result.status === moduleConstants.compileCacheStatus.FAILED) {
      console.warn(
        "[Bootstrap] Compile cache enablement failed — main-process modules will not be cached. Directory:",
        cacheDir
      );
    }
  }
}

// Run forward-only boot migrations before anything in main.ts touches state.
// Failures are logged but non-fatal — forward-only idempotency means the
// failing migration retries on the next boot, and the app should still be
// usable as long as existing state is intact.
try {
  await runBootMigrations({ isSafeMode: isSafeModeActive() });
} catch (err) {
  console.error("[Bootstrap] Boot migrations failed — continuing with existing state:", err);
}

// Initialize the persistent store at an explicit lifecycle point. Two failure
// modes are surfaced via a native error dialog before the renderer ever loads:
//   1. An unexpected throw escapes initializeStore() (defensive — the function
//      catches its own constructor failures internally).
//   2. initializeStore() falls back to the in-memory store (path === "") — this
//      means the on-disk store is unrecoverable (e.g. EPERM, ENOSPC, or both
//      config and backup are corrupt). Letting the app continue would lose any
//      user changes on the next restart, silently.
// dialog.showErrorBox is safe pre-app.whenReady() on macOS and Windows; on Linux
// it falls back to stderr, which is still better than a silent failure.
function showFatalStoreError(reason: string): void {
  dialog.showErrorBox(
    "Couldn't start Daintree",
    `Failed to initialize settings.\n\nPath: ${app.getPath("userData")}\n\n${reason}`
  );
  app.exit(1);
}

try {
  initializeStore();
  if (_peekStoreInstance()?.path === "") {
    showFatalStoreError(
      "Settings file is unreadable and the on-disk fallback couldn't be created. The app would lose any changes on restart. Check disk space and folder permissions for the path above, then relaunch."
    );
  }
} catch (err) {
  showFatalStoreError(formatErrorMessage(err, "Unknown store initialization error"));
}

await import("./main.js");

// Persist any compile-cache entries written during boot. enableCompileCache()
// only flushes on a clean process exit, so a crash or SIGKILL before the first
// graceful quit would leave the cache empty forever — every launch staying
// cache-cold. Flushing here, after the boot-critical main.js import resolves,
// guarantees first-run writes survive an unclean exit. flushCompileCache() is
// synchronous but cheap (one fs write) and runs after boot work, off the hot
// path. Feature-detected and wrapped so a missing/throwing API can't break boot.
try {
  if (typeof flushCompileCache === "function") {
    flushCompileCache();
  }
} catch (err) {
  console.warn("[Bootstrap] flushCompileCache after boot failed:", err);
}
