import { BrowserWindow } from "electron";
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { CHANNELS } from "../ipc/channels.js";
import { broadcastToRenderer } from "../ipc/utils.js";
import { getCliAvailabilityServiceRef } from "../window/serviceRefs.js";
import type { ConfigBundleService } from "./ConfigBundleService.js";

/**
 * The one `ConfigBundleService` this process uses, and the one queue its
 * writes go through. A file import from any window and a copy a Shell sends
 * to this machine as a host (#13346) both apply here: two applies
 * interleaving their section writes could roll one back over the other's
 * changes, since each holds its own pre-import snapshot.
 */

let servicePromise: Promise<ConfigBundleService> | undefined;
let writeChain: Promise<void> = Promise.resolve();

function anyWindow(): BrowserWindow | undefined {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
}

async function rebuildMenu(): Promise<void> {
  const win = anyWindow();
  if (!win) return;
  const { createApplicationMenu } = await import("../menu.js");
  createApplicationMenu(win, getCliAvailabilityServiceRef() ?? undefined);
}

// Lazily imported: the menu and theme modules don't belong on the boot path.
async function refreshTitleBar(): Promise<void> {
  const { refreshTitleBarOverlayTheme } = await import("../ipc/handlers/appTheme.js");
  refreshTitleBarOverlayTheme();
}

/**
 * Whether `command` is an executable on this process's PATH. Advisory only:
 * it decides whether a copied custom agent carries a "not installed" note.
 */
export async function commandOnPath(command: string): Promise<boolean> {
  if (command === "" || command.includes("/") || command.includes("\\")) return false;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((ext) => command + ext)
      : [command];
  for (const dir of dirs) {
    for (const name of names) {
      try {
        await fs.access(path.join(dir, name), fsConstants.X_OK);
        return true;
      } catch {
        // Not in this directory.
      }
    }
  }
  return false;
}

export function getConfigBundleService(): Promise<ConfigBundleService> {
  servicePromise ??= import("./ConfigBundleService.js").then(
    ({ ConfigBundleService }) =>
      new ConfigBundleService({
        rebuildMenu,
        refreshTitleBar,
        availability: () => getCliAvailabilityServiceRef()?.getAvailability() ?? null,
        commandAvailable: commandOnPath,
      })
  );
  return servicePromise;
}

/** Run `write` after every config write already queued, whether those succeeded or not. */
export function runConfigWrite<T>(write: () => Promise<T>): Promise<T> {
  const run = writeChain.then(write, write);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * After settings were written with no window asking: bring this process's
 * own mirrors in line, then tell every view. The views' own refresh
 * (`refreshImportedConfig`) runs the same reload again, which is harmless;
 * on a host with no window open, this is the only reload there is.
 */
export async function reconcileAfterConfigWrite(): Promise<void> {
  const { UserAgentRegistryService } = await import("./UserAgentRegistryService.js");
  new UserAgentRegistryService().reload();
  await rebuildMenu();
  const { events } = await import("./events.js");
  events.emit("sys:config:reload");
  broadcastToRenderer(CHANNELS.APP_CONFIG_RELOADED);
  broadcastToRenderer(CHANNELS.CONFIG_BUNDLE_IMPORTED);
}

/** Forget the service, for tests. */
export function resetConfigBundleRuntimeForTests(): void {
  servicePromise = undefined;
  writeChain = Promise.resolve();
}
