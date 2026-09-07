// Entry module for the plugin worker (#9304), run inside a `utilityProcess.fork`
// child. It imports the plugin's built bundle, calls `activate(proxyHost)`, and
// relays every host-API call back to the main process over the parent
// MessagePort. A reload kills this whole process and forks a fresh one, so
// module-scope state never leaks across reloads (the robust fix for Vite #14438).
//
// A plugin with no `main` gets a worker too (#12274): there is no bundle to
// import, so the harness boots and reports activated, then imports each manifest
// command's handler module on its first dispatch. That is the last surface that
// used to run plugin code in Electron main.

import { PluginDevWorkerHostProxy } from "./services/plugin/pluginDevWorkerHostProxy.js";
import { formatErrorMessage } from "../shared/utils/errorMessage.js";
import type { PluginActivate, PluginIdentity } from "../shared/types/plugin.js";
import type {
  PluginHostToWorkerMessage,
  PluginWorkerToHostMessage,
} from "../shared/types/pluginDevWorker.js";

if (!process.parentPort) {
  throw new Error("[PluginDevWorker] Must run in a UtilityProcess context");
}

const port = process.parentPort as unknown as {
  on: (event: "message", listener: (msg: unknown) => void) => void;
  postMessage: (msg: PluginWorkerToHostMessage) => void;
};

const post = (msg: PluginWorkerToHostMessage): void => {
  port.postMessage(msg);
};

// Unhandled rejections / uncaught exceptions are only WARNED about in Electron
// utility processes (37+), not fatal — so a bad plugin `activate()` would
// silently corrupt state instead of triggering a reload. Force a fast exit so
// the parent's `exit` handler supervises a respawn.
process.on("unhandledRejection", (reason) => {
  console.error("[PluginDevWorker] Unhandled rejection:", reason);
  setImmediate(() => process.exit(1));
});
process.on("uncaughtException", (err) => {
  console.error("[PluginDevWorker] Uncaught exception:", err);
  setImmediate(() => process.exit(1));
});

let proxy: PluginDevWorkerHostProxy | null = null;
let cleanup: (() => void) | null = null;
let started = false;

async function start(
  bundleUrl: string | undefined,
  pluginId: string,
  identity: PluginIdentity
): Promise<void> {
  if (started) return;
  started = true;

  proxy = new PluginDevWorkerHostProxy(pluginId, post, identity);

  if (!bundleUrl) {
    // Commands-only plugin (#12274): no `main`, so there is no bundle and no
    // `activate()` — the worker exists to import and run this plugin's manifest
    // command handlers on dispatch. Report activated so the host's activation
    // gate settles, then wait. Mirrors the no-`activate`-export branch below;
    // the process-level error guards above are already installed either way, so
    // a command import that throws asynchronously still exits observably rather
    // than leaving a zombie worker.
    proxy.revoke();
    post({ type: "activated", hasCleanup: false });
    return;
  }

  let mod: { activate?: unknown };
  try {
    mod = (await import(bundleUrl)) as { activate?: unknown };
  } catch (err) {
    post({
      type: "activate-error",
      error: formatErrorMessage(err, "failed to import plugin bundle"),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return;
  }

  if (typeof mod.activate !== "function") {
    // A plugin with no `activate` export is valid (contributions only).
    proxy.revoke();
    post({ type: "activated", hasCleanup: false });
    return;
  }

  const activate = mod.activate as PluginActivate;
  try {
    const result = await activate(proxy.host);
    if (typeof result === "function") {
      cleanup = result;
    }
    post({ type: "activated", hasCleanup: cleanup !== null });
  } catch (err) {
    post({
      type: "activate-error",
      error: formatErrorMessage(err, "activate() threw"),
      stack: err instanceof Error ? err.stack : undefined,
    });
  } finally {
    // Close the registration window once activate settles, mirroring the real
    // host's revoke. Post-activation callbacks (toasts, dispatch, settings) stay
    // callable — only the register* surface is revoked.
    proxy.revoke();
  }
}

function disposeAndExit(): void {
  try {
    cleanup?.();
  } catch (err) {
    console.error("[PluginDevWorker] Plugin cleanup threw:", err);
  } finally {
    cleanup = null;
    proxy?.dispose();
    proxy = null;
    setImmediate(() => process.exit(0));
  }
}

port.on("message", (rawMsg: unknown) => {
  const msg = (
    rawMsg && typeof rawMsg === "object" && "data" in rawMsg
      ? (rawMsg as { data: unknown }).data
      : rawMsg
  ) as PluginHostToWorkerMessage;

  switch (msg.type) {
    case "start":
      void start(msg.bundleUrl, msg.pluginId, msg.identity);
      return;
    case "dispose":
      disposeAndExit();
      return;
    default:
      proxy?.handleMessage(msg);
  }
});

// Announce readiness only after the message listener is attached, so the
// parent's `start` (sent on `ready`) can never race ahead of the listener.
//
// `permission.present` is the spike self-check (#10890): report whether Node's
// experimental permission model is actually active in this worker. `process`
// only exposes `.permission` when `--permission` engaged, so its mere presence
// is the honest signal for whether Electron honored the `execArgv` flags. On
// Electron 42 this is expected to be `false` even when the flags were passed.
const permissionPresent =
  (process as { permission?: unknown }).permission !== undefined &&
  (process as { permission?: unknown }).permission !== null;
post({ type: "ready", permission: { present: permissionPresent } });
