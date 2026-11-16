// The app's boot, imported by bootstrap.ts once the compile cache is on, so
// this graph (environment, store, migrations, main) is parsed with caching.
// Environment setup comes first, as it did when bootstrap.ts imported it.
import { isSmokeTest } from "../setup/environment.js";

import { app, dialog } from "electron";
import { BOOT_MIGRATIONS, runBootMigrations } from "./migrations/index.js";
import { isSafeModeActive } from "../services/CrashLoopGuardService.js";
import { initializeStore, _peekStoreInstance, runDeferredStoreBackup } from "../store.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import { installSpawnCensusFromEnv } from "../utils/spawnCensus.js";
import { getIsIdleHarness } from "../setup/runtimeFlags.js";
import { applyMainFileIoPolicy } from "../setup/mainFileIoPolicy.js";

// Idle harness spawn census (#12521). Needs both the runner's variable and an
// unpackaged idle-harness launch; anything else drops the variable before a
// host can inherit it. Before main.js loads, so every launch main makes is seen.
installSpawnCensusFromEnv("main", { allowed: getIsIdleHarness() });

// Run forward-only boot migrations before anything in main.ts touches state.
// Guarded on the registry so the common empty-registry boot skips the
// safe-mode file read, the marker-file ENOENT read, and the awaited hop —
// registering a migration in BOOT_MIGRATIONS reactivates this automatically.
// Failures are logged but non-fatal — forward-only idempotency means the
// failing migration retries on the next boot.
try {
  if (BOOT_MIGRATIONS.length > 0) {
    await runBootMigrations({ isSafeMode: isSafeModeActive() });
  }
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

// Ahead of main.js, whose project reads would otherwise reach libuv's workers
// first. Not awaited: it only queues pool work in front of theirs (#16361).
void applyMainFileIoPolicy();

await import("../main.js");

// Refresh the config.json.bak copy (and tighten its permissions) off the
// boot-critical path. initializeStore() used to do this synchronously before
// main.js loaded; the previous session's .bak stays valid for corrupt-config
// recovery until this fires, so deferring loses nothing.
setImmediate(() => {
  // A second launch kept open to ask about a headless Host (see
  // remote/host/headlessHostTakeover.ts) doesn't own the settings.
  if (!isSmokeTest && !app.hasSingleInstanceLock()) return;
  runDeferredStoreBackup();
});
