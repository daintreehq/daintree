// The app's entry. Its static imports are parsed before the compile cache is
// on, and they are all the `--attach-stdio` bridge loads besides its own
// module, so they stay on Node built-ins, Electron and pure helpers. The boot
// proper (environment, migrations, store, main.js) is boot/appBoot.ts, imported
// once the cache is enabled.
import { enableCompileCache, flushCompileCache, constants as moduleConstants } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { setCompileCacheEnableStatus } from "./utils/hostPerformance.js";
import {
  isAttachStdioRequested,
  isSshAskpassRequested,
  shouldUseHeadlessOzone,
} from "./boot/hostModeLaunch.js";
import { isRemoteHostSupported, isRemoteShellSupported } from "./remote/buildGate.js";
import {
  applyDevUserDataPath,
  applyHeadlessOzoneSwitches,
  installStdioDeadFdGuards,
  resetUserDataIfRequested,
} from "./setup/earlyEnvironment.js";

installStdioDeadFdGuards();

// Before anything reads `app.getPath("userData")`: a dev instance keeps its
// compile cache, migrations and store (and on macOS the attach bridge's host
// socket) in its own profile, not the production app's.
applyDevUserDataPath();

// `--attach-stdio` carries a Shell's link to the Daintree already running here
// (see remote/host/attachStdio.ts). It is dispatched before anything else
// touches state: no environment setup, no boot migrations, no store, no
// compile cache, and never main.js, whose single-instance lock would make it a
// second instance that quits and hands its argv to the running one as a
// launch. stdout carries the link. The process exits once either side of the
// pipe closes.
if (isRemoteHostSupported() && isAttachStdioRequested(process.argv)) {
  // On Linux without a display it runs headless, like `--host-mode`.
  if (
    shouldUseHeadlessOzone({ platform: process.platform, argv: process.argv, env: process.env })
  ) {
    applyHeadlessOzoneSwitches({ hardwareAccelerationDisabled: false });
  }
  let code = 1;
  if (__DAINTREE_REMOTE_HOST_ROLE__) {
    try {
      const { runAttachStdioCli } = await import("./remote/host/attachStdioCli.js");
      code = await runAttachStdioCli();
    } catch (error) {
      process.stderr.write(`daintree: attach failed: ${String(error)}\n`);
    }
  }
  app.exit(code);
  // Nothing below may run in this process.
  await new Promise<never>(() => {});
}

// `--ssh-askpass` is ssh's SSH_ASKPASS while a Remote Hosts sign-in runs (see
// remote/client/sshAskpass.ts): it hands one prompt to the Daintree that
// started that ssh and prints the answer. Dispatched here for the same
// reasons as the attach bridge; stdout carries the answer. Windows never
// runs ssh for a host.
if (
  isRemoteShellSupported() &&
  process.platform !== "win32" &&
  isSshAskpassRequested(process.argv)
) {
  let code = 1;
  if (__DAINTREE_REMOTE_HOSTS__) {
    try {
      const { runSshAskpassCli } = await import("./remote/client/sshAskpassCli.js");
      code = await runSshAskpassCli();
    } catch (error) {
      process.stderr.write(`daintree: askpass failed: ${String(error)}\n`);
    }
  }
  app.exit(code);
  await new Promise<never>(() => {});
}

// Before the compile cache creates its directory inside userData.
resetUserDataIfRequested();

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

await import("./boot/appBoot.js");

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
