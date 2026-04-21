import { enableCompileCache } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { runBootMigrations } from "./boot/migrations/index.js";

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
//
// TODO: wire `isSafeMode` from CrashLoopGuardService once it initializes
// here rather than inside main.ts — today the guard boots after bootstrap,
// so safe-mode detection isn't available at this point.
try {
  await runBootMigrations();
} catch (err) {
  console.error("[Bootstrap] Boot migrations failed — continuing with existing state:", err);
}

await import("./main.js");
