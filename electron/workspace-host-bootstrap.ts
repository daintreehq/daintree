import { enableCompileCache } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { PERF_MARKS } from "../shared/perf/marks.js";
import { getCompileCacheMeta, markHostPerformance } from "./utils/hostPerformance.js";

const userData = process.env.DAINTREE_USER_DATA;
if (userData) {
  const cacheDir = path.join(userData, "compile-cache");
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    enableCompileCache(cacheDir);
  } catch (e) {
    console.warn(
      "[WorkspaceHost] Compile-cache directory unavailable, falling back to default:",
      cacheDir,
      e
    );
    enableCompileCache();
  }
} else {
  enableCompileCache();
}

// Bookends the bootstrap module's synchronous setup (enableCompileCache +
// mkdirSync). The phase BETWEEN this mark and WORKSPACE_HOST_NATIVE_MODULE_READY
// is the host module's evaluation — ESM import graph resolution and native
// dlopen for better-sqlite3 and @parcel/watcher. We mark here, not after the
// dynamic import, because after `await import()` the host has already posted
// `ready`.
markHostPerformance(PERF_MARKS.WORKSPACE_HOST_MODULE_EVAL_COMPLETE, getCompileCacheMeta());

await import("./workspace-host.js");
