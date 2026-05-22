import { enableCompileCache } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { PERF_MARKS } from "../shared/perf/marks.js";
import { getCompileCacheMeta, markHostPerformance } from "./utils/hostPerformance.js";
import { installBootstrapErrorGuard } from "./utils/bootstrapErrorGuard.js";

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

// Bookends the bootstrap module's synchronous setup (enableCompileCache +
// mkdirSync). The phase BETWEEN this mark and PTY_HOST_NATIVE_MODULE_READY is
// the host module's evaluation — ESM import graph resolution and native
// dlopen for node-pty. We mark here, not after the dynamic import, because
// after `await import()` the host has already posted `ready`.
markHostPerformance(PERF_MARKS.PTY_HOST_MODULE_EVAL_COMPLETE, getCompileCacheMeta());

// Guard the dynamic import below: a native-load failure (e.g. node-pty
// ERR_DLOPEN_FAILED) would otherwise hang the parent's waitForReady() forever,
// since Electron 37+ only warns on unhandled rejections in utility processes.
installBootstrapErrorGuard({
  label: "[PtyHostBootstrap]",
  postError: (error) => {
    const port = process.parentPort as unknown as MessagePort | undefined;
    port?.postMessage({ type: "error", id: "system", error });
  },
});

await import("./pty-host.js");
