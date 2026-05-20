import { enableCompileCache } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { PERF_MARKS } from "../shared/perf/marks.js";
import { getCompileCacheMeta, markHostPerformance } from "./utils/hostPerformance.js";

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

markHostPerformance(PERF_MARKS.PTY_HOST_MODULE_EVAL_COMPLETE, getCompileCacheMeta());

await import("./pty-host.js");
