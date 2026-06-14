import { enableCompileCache } from "node:module";
import fs from "node:fs";
import path from "node:path";
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

// Guard the dynamic import below: a failure while loading the worker module
// would otherwise hang the parent's start()/waitForReady() forever, since
// Electron 37+ only WARNS on unhandled rejections in utility processes instead
// of crashing. Convert that silent hang into a fast, observable exit.
const removeBootstrapGuard = installBootstrapErrorGuard({
  label: "[PluginDevWorkerBootstrap]",
  postError: (error) => {
    // Shape must match the `error` variant of PluginWorkerToHostMessage.
    const port = process.parentPort as unknown as MessagePort | undefined;
    port?.postMessage({ type: "error", error });
  },
});

await import("./plugin-dev-worker.js");

// Import succeeded — plugin-dev-worker.ts installs its own lifetime handlers
// during evaluation, so drop the bootstrap guard to avoid double-reporting.
removeBootstrapGuard();
