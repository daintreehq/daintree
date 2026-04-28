// Environment setup must run before anything that reads `app.getPath("userData")`
// — in dev mode it calls `app.setPath("userData", "daintree-dev")` so the dev
// instance doesn't collide with the production app. Importing it here ensures
// runBootMigrations, the compile-cache dir, and initializeStore all resolve to
// the correct directory before main.ts re-imports it (idempotent via ESM cache).
import "./setup/environment.js";

import { enableCompileCache } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { app, dialog } from "electron";
import { runBootMigrations } from "./boot/migrations/index.js";
import { isSafeModeActive } from "./services/CrashLoopGuardService.js";
import { initializeStore, _peekStoreInstance } from "./store.js";
import { formatErrorMessage } from "../shared/utils/errorMessage.js";

const cacheDir = path.join(app.getPath("userData"), "compile-cache");
try {
  fs.mkdirSync(cacheDir, { recursive: true });
  enableCompileCache(cacheDir);
} catch {
  enableCompileCache();
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
