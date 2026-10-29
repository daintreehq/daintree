// eager-import-allow: stats the launched bundle synchronously at boot, before anything can replace it
/**
 * Whether the app bundle on disk is still the one this process was launched
 * from (#14937). Replacing `/Applications/Daintree.app` under a running
 * Daintree (`install:local`, a fleet deploy, a Finder drag) leaves this
 * process running against a bundle macOS no longer recognises as it: TCC then
 * denies the microphone and coreaudiod feeds exact-zero samples, while every
 * check the app can make (permission, track state) still reports healthy.
 *
 * The identity is the physical executable and `app.asar`, stat'd once at boot
 * and compared on demand. Both resolve to new inodes after a rename-swap
 * install, and an in-place rsync replaces at least the archive. It says the
 * files changed, never why the mic is silent, so callers word it as such.
 *
 * Only a packaged macOS app is checked: that is the only place a replaced
 * bundle silences the mic, and a dev run's executable is Electron's own.
 */

import type { BigIntStats, StatSyncOptions } from "node:fs";
import path from "node:path";

type NativeStatSync = (path: string, options: StatSyncOptions & { bigint: true }) => BigIntStats;

interface FileIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

export interface AppBundleIdentityOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  resourcesPath: string | undefined;
  /**
   * Must return the unpatched stat: Electron's `fs` answers a stat of
   * `app.asar` with synthesized metadata whose inode changes on every call.
   * Only called on a packaged macOS app.
   */
  loadStatSync: () => NativeStatSync;
}

let baseline: { files: FileIdentity[]; statSync: NativeStatSync } | null = null;

function identify(file: string, statSync: NativeStatSync): FileIdentity {
  const stats = statSync(file, { bigint: true });
  return { path: file, dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs };
}

function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Records the running bundle's identity. Call once, as early in boot as
 * possible: a replacement before this call is invisible. Later calls keep the
 * first baseline, so a query can never adopt the replaced bundle as its own.
 */
export function captureAppBundleIdentity(options: AppBundleIdentityOptions): void {
  if (baseline) return;
  if (options.platform !== "darwin" || !options.isPackaged || !options.resourcesPath) return;
  const paths = [options.execPath, path.join(options.resourcesPath, "app.asar")];
  try {
    const statSync = options.loadStatSync();
    baseline = { files: paths.map((file) => identify(file, statSync)), statSync };
  } catch {
    // Without a baseline nothing can be compared, so nothing is reported.
    baseline = null;
  }
}

/**
 * True when a file of the launched bundle is gone or is no longer the file
 * this process started from. An unreadable file (EACCES, EIO) is unknown,
 * not replaced.
 */
export function isAppBundleReplaced(): boolean {
  if (!baseline) return false;
  const { files, statSync } = baseline;
  for (const file of files) {
    let current: FileIdentity;
    try {
      current = identify(file.path, statSync);
    } catch (err) {
      if (isGone(err)) return true;
      continue;
    }
    if (
      current.dev !== file.dev ||
      current.ino !== file.ino ||
      current.size !== file.size ||
      current.mtimeNs !== file.mtimeNs
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a restart has a whole bundle to come back up as. Mid-swap, after an
 * interrupted copy, or with the app moved to the Trash, a relaunch would quit
 * Daintree and start nothing.
 */
export function isAppBundleLaunchable(): boolean {
  if (!baseline) return false;
  const { files, statSync } = baseline;
  try {
    return files.every((file) => statSync(file.path, { bigint: true }).isFile());
  } catch {
    return false;
  }
}

export function resetAppBundleIdentityForTests(): void {
  baseline = null;
}
