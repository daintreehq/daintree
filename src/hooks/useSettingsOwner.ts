import { useEffect, useSyncExternalStore } from "react";
import {
  SETTING_CATALOG,
  rendererStorageOwner,
  settingOwner,
  type SettingOwner,
  type SettingPath,
} from "@shared/config/settingOwnership";
import { isMac, isWindows } from "@/lib/platform";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";
import { currentHostId, isRemoteWindow, useHostPlatform } from "@/hooks/useHostPlatform";

/**
 * Whose values a settings surface edits in a window attached to another host:
 * the host's (everything about the work), this machine's (the screen, keyboard
 * and this computer), or a page holding both, whose sections name their own.
 */
export type SettingsOwner = SettingOwner | "mixed";

/** The machine at the keyboard, named the way the person knows it. */
export function deviceOwnerLabel(): string {
  if (isMac()) return "This Mac";
  return isWindows() ? "This PC" : "This machine";
}

/** The same machine mid-sentence. */
export function deviceOwnerPhrase(): string {
  if (isMac()) return "this Mac";
  return isWindows() ? "this PC" : "this machine";
}

/** The remote host a view belongs to, by display name; null in a local window. */
export function useRemoteHostName(): string | null {
  const { hostName } = useHostPlatform();
  if (!isRemoteWindow()) return null;
  return hostName ?? currentHostId();
}

/**
 * What names an owner on screen: the host a remote window works on, or null in
 * a local window. `shown` is false in a local window with no hosts in use and
 * Host mode off, where nothing names an owner and Settings reads as it always has.
 */
export interface OwnerContext {
  readonly remoteHostName: string | null;
  readonly shown: boolean;
}

let hostsInUse: boolean | null = null;
let hostsInUseRequest: Promise<void> | null = null;
const hostsInUseListeners = new Set<() => void>();

function setHostsInUse(next: boolean): void {
  if (hostsInUse === next) return;
  hostsInUse = next;
  for (const listener of [...hostsInUseListeners]) listener();
}

/** Asks main again whether a host is configured or Host mode is on. */
export function refreshSettingOwnersShown(): void {
  const inUse = window.electron?.remoteHosts?.isInUse;
  if (typeof inUse !== "function" || hostsInUseRequest) return;
  hostsInUseRequest = inUse()
    .then(setHostsInUse, () => {})
    .finally(() => {
      hostsInUseRequest = null;
    });
}

let watchingHostList = false;

/** Adding the first host, or removing the last, changes whether owners are shown. */
function watchHostList(): void {
  if (watchingHostList) return;
  watchingHostList = true;
  let count = useRemoteHostsStore.getState().hosts.length;
  useRemoteHostsStore.subscribe((state) => {
    if (state.hosts.length === count) return;
    count = state.hosts.length;
    refreshSettingOwnersShown();
  });
}

function subscribeHostsInUse(listener: () => void): () => void {
  hostsInUseListeners.add(listener);
  return () => {
    hostsInUseListeners.delete(listener);
  };
}

export function _resetSettingOwnersShownForTests(): void {
  hostsInUse = null;
  hostsInUseRequest = null;
  hostsInUseListeners.clear();
}

export function useOwnerContext(): OwnerContext {
  const remoteHostName = useRemoteHostName();
  const inUse = useSyncExternalStore(
    subscribeHostsInUse,
    () => hostsInUse,
    () => null
  );
  const unknown = remoteHostName === null && inUse === null;
  useEffect(() => {
    watchHostList();
    if (unknown) refreshSettingOwnersShown();
  }, [unknown]);
  return { remoteHostName, shown: remoteHostName !== null || inUse === true };
}

type LocalStorageKey = keyof (typeof SETTING_CATALOG)["renderer-local-storage"]["entries"] & string;

/**
 * A setting a surface edits: a path in the main settings file, or a key this
 * machine's renderer keeps in local storage, written `storage:<key>`.
 */
export type SettingRef = SettingPath | `storage:${LocalStorageKey}`;

const STORAGE_PREFIX = "storage:";

export function ownerOfSetting(ref: SettingRef): SettingOwner {
  return ref.startsWith(STORAGE_PREFIX)
    ? rendererStorageOwner(ref.slice(STORAGE_PREFIX.length))
    : settingOwner(ref as SettingPath);
}

/** The one owner a set of settings shares; null when they differ. */
export function sharedSettingOwner(paths: readonly SettingRef[]): SettingOwner | null {
  const owners = new Set(paths.map((path) => ownerOfSetting(path)));
  return owners.size === 1 ? ([...owners][0] ?? null) : null;
}

/** What a page of settings shares: its one owner, or `mixed` when the owners differ. */
export function settingsOwnerOf(paths: readonly SettingRef[]): SettingsOwner {
  return sharedSettingOwner(paths) ?? "mixed";
}

/** What names an owner: "On studio-03", "This Mac", or on a host's own screen "Shared with Shells". */
export function ownerLabel(owner: SettingOwner, context: OwnerContext): string | undefined {
  if (!context.shown) return undefined;
  if (owner === "device") return deviceOwnerLabel();
  return context.remoteHostName === null ? "Shared with Shells" : `On ${context.remoteHostName}`;
}

/** The dialog header's owner line; null when no owner is named and for mixed pages. */
export function settingsOwnerHeaderLabel(
  owner: SettingsOwner,
  context: OwnerContext
): string | null {
  if (owner === "mixed" || !context.shown) return null;
  if (owner === "host" && context.remoteHostName !== null) {
    return `Settings on ${context.remoteHostName}`;
  }
  return ownerLabel(owner, context) ?? null;
}

/**
 * The marker for a section or row, taken from the declared owner of what it
 * writes. Nothing when owners aren't shown, and nothing when the settings
 * differ in owner: the rows beneath each name their own.
 */
export function settingsOwnerMarker(
  paths: readonly SettingRef[],
  context: OwnerContext
): string | undefined {
  const owner = sharedSettingOwner(paths);
  return owner === null ? undefined : ownerLabel(owner, context);
}

export function useSettingsOwnerMarker(): (...paths: SettingRef[]) => string | undefined {
  const context = useOwnerContext();
  return (...paths) => settingsOwnerMarker(paths, context);
}

/** Two badges on one heading, the owner last; the first alone when none is named. */
export function joinBadges(
  badge: string | undefined,
  marker: string | undefined
): string | undefined {
  if (!badge) return marker;
  return marker ? `${badge} · ${marker}` : badge;
}

/** Where one row's value lives, for the odd row whose owner differs from its section's. */
export function settingsRowOwnerNote(
  paths: readonly SettingRef[],
  context: OwnerContext
): string | undefined {
  const owner = sharedSettingOwner(paths);
  if (owner === null || !context.shown) return undefined;
  if (owner === "device") return `Set on ${deviceOwnerPhrase()}`;
  return context.remoteHostName === null
    ? "Shared with Shells"
    : `Set on ${context.remoteHostName}`;
}

/**
 * A row description with its owner appended, matching the description's own
 * punctuation. The description, untouched, when owners aren't shown.
 */
export function useSettingsRowOwnerNote(): (description: string, ...paths: SettingRef[]) => string {
  const context = useOwnerContext();
  return (description, ...paths) => {
    const note = settingsRowOwnerNote(paths, context);
    if (!note) return description;
    return description.endsWith(".") ? `${description} ${note}.` : `${description} · ${note}`;
  };
}

/** A forge with no credentials on the host the window works on; each host signs in on its own. */
export function forgeNotConnectedLabel(providerName: string, remoteHostName: string): string {
  return `${providerName} isn't connected on ${remoteHostName}`;
}
