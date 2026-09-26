import { useSyncExternalStore } from "react";
import {
  LOCAL_HOST_ID,
  isValidRemoteHostId,
  toHostScopedKey,
  type HostConnection,
} from "@shared/types/remoteHosts";
import { isLinux, isMac, isWindows } from "@/lib/platform";

export type HostPlatformName = "darwin" | "linux" | "win32";

export interface HostPlatformInfo {
  /** The platform of the machine this view's project lives on. */
  platform: HostPlatformName;
  homeDir: string | null;
  tmpDir: string | null;
  /** Display name of a remote host; null for this machine. */
  hostName: string | null;
  /** How a remote host is reached; null for this machine. */
  connection: HostConnection | null;
}

/**
 * Until main reports the host, every question falls through to the client's
 * own platform helpers, so a view that never hydrates host fields behaves
 * exactly as it did before hosts existed.
 */
let seededPlatform: HostPlatformName | null = null;
let info: HostPlatformInfo | null = null;
const listeners = new Set<() => void>();

function clientPlatform(): HostPlatformName {
  if (isMac()) return "darwin";
  if (isWindows()) return "win32";
  return "linux";
}

function snapshot(): HostPlatformInfo {
  info ??= {
    platform: seededPlatform ?? clientPlatform(),
    homeDir: null,
    tmpDir: null,
    hostName: null,
    connection: null,
  };
  return info;
}

export function setHostPlatformInfo(partial: Partial<HostPlatformInfo>): void {
  if (partial.platform !== undefined) seededPlatform = partial.platform;
  info = { ...snapshot(), ...partial };
  for (const listener of [...listeners]) listener();
}

export function getHostPlatformInfo(): HostPlatformInfo {
  return snapshot();
}

export function subscribeHostPlatform(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getHostPlatform(): HostPlatformName {
  return seededPlatform ?? clientPlatform();
}

export function isHostMac(): boolean {
  return seededPlatform ? seededPlatform === "darwin" : isMac();
}

export function isHostLinux(): boolean {
  return seededPlatform ? seededPlatform === "linux" : isLinux();
}

export function isHostWindows(): boolean {
  return seededPlatform ? seededPlatform === "win32" : isWindows();
}

/**
 * The shell dialect for commands that run on the host. Undefined until the
 * host is known, which leaves the escaper on its own platform detection.
 */
export function hostShellDialect(): "posix" | "windows" | undefined {
  if (!seededPlatform) return undefined;
  return seededPlatform === "win32" ? "windows" : "posix";
}

/** This view's host id: "local" unless the view belongs to a remote host. */
export function currentHostId(): string {
  const id = typeof window === "undefined" ? undefined : window.__DAINTREE_HOST_ID__?.id;
  return typeof id === "string" && isValidRemoteHostId(id) ? id : LOCAL_HOST_ID;
}

export function isRemoteWindow(): boolean {
  return currentHostId() !== LOCAL_HOST_ID;
}

/** A persisted key for something scoped to this view's project: bare locally. */
export function hostScopedKey(id: string): string {
  return toHostScopedKey(currentHostId(), id);
}

/**
 * A file manager on a remote host's screen is no use to the person driving,
 * so for a remote window the reveal action copies the host path instead. The
 * other names match `fileManagerRevealLabel`, asked of the host's platform.
 */
export function hostFileManagerRevealLabel(): string {
  if (isRemoteWindow()) return "Copy host path";
  if (isHostMac()) return "Show in Finder";
  if (isHostWindows()) return "Show in Explorer";
  return "Show in file manager";
}

/** The host's temp dir when main has reported it, otherwise whatever `fallback` resolves. */
export function resolveHostTmpDir(fallback: () => Promise<string>): Promise<string> {
  const tmpDir = snapshot().tmpDir;
  return tmpDir ? Promise.resolve(tmpDir) : fallback();
}

export function useHostPlatform(): HostPlatformInfo {
  return useSyncExternalStore(subscribeHostPlatform, snapshot, snapshot);
}

/** @internal Tests only. */
export function _resetHostPlatformForTests(): void {
  seededPlatform = null;
  info = null;
  listeners.clear();
}
