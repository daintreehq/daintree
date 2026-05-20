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

markHostPerformance(PERF_MARKS.WORKSPACE_HOST_MODULE_EVAL_COMPLETE, getCompileCacheMeta());

await import("./workspace-host.js");
