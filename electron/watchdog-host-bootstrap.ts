import { enableCompileCache, flushCompileCache } from "node:module";
import fs from "node:fs";
import path from "node:path";

const userData = process.env.DAINTREE_USER_DATA;
if (userData) {
  try {
    const cacheDir = path.join(userData, "compile-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    enableCompileCache(cacheDir);
  } catch {
    enableCompileCache();
  }
} else {
  enableCompileCache();
}

await import("./watchdog-host.js");

// Flush compile-cache entries written during this host's boot. See the
// equivalent block in pty-host-bootstrap.ts for rationale.
setImmediate(() => {
  try {
    flushCompileCache();
  } catch {
    // Non-fatal: next boot will re-parse from source.
  }
});
