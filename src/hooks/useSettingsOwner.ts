import { isMac } from "@/lib/platform";
import { currentHostId, isRemoteWindow, useHostPlatform } from "@/hooks/useHostPlatform";

/**
 * Whose values a settings surface edits in a window attached to another host:
 * the host's (everything about the work), this machine's (the screen, keyboard
 * and this computer), or a page holding both, whose sections name their own.
 */
export type SettingsOwner = "host" | "device" | "mixed";

/** The machine at the keyboard, named the way the person knows it. */
export function deviceOwnerLabel(): string {
  return isMac() ? "This Mac" : "This machine";
}

/** The same machine mid-sentence. */
export function deviceOwnerPhrase(): string {
  return isMac() ? "this Mac" : "this machine";
}

/** The remote host a view belongs to, by display name; null in a local window. */
export function useRemoteHostName(): string | null {
  const { hostName } = useHostPlatform();
  if (!isRemoteWindow()) return null;
  return hostName ?? currentHostId();
}

/** The dialog header's owner line; null locally and for mixed pages. */
export function settingsOwnerHeaderLabel(
  owner: SettingsOwner,
  remoteHostName: string | null
): string | null {
  if (remoteHostName === null) return null;
  if (owner === "host") return `Settings on ${remoteHostName}`;
  if (owner === "device") return deviceOwnerLabel();
  return null;
}

/** A section or row marker on a mixed page; undefined locally so nothing renders. */
export function settingsOwnerMarker(
  owner: Exclude<SettingsOwner, "mixed">,
  remoteHostName: string | null
): string | undefined {
  if (remoteHostName === null) return undefined;
  return owner === "host" ? `On ${remoteHostName}` : deviceOwnerLabel();
}

/**
 * The marker for one section or row of a mixed settings page. Nothing in a
 * local window, so a page with no hosts renders exactly as it always has.
 */
export function useSettingsOwnerMarker(): (
  owner: Exclude<SettingsOwner, "mixed">
) => string | undefined {
  const remoteHostName = useRemoteHostName();
  return (owner) => settingsOwnerMarker(owner, remoteHostName);
}

/** Two badges on one heading, the owner last; the first alone locally. */
export function joinBadges(badge: string, marker: string | undefined): string {
  return marker ? `${badge} · ${marker}` : badge;
}

/** Where one row's value lives, for the odd row whose owner differs from its section's. */
export function settingsRowOwnerNote(
  owner: Exclude<SettingsOwner, "mixed">,
  remoteHostName: string | null
): string | undefined {
  if (remoteHostName === null) return undefined;
  return owner === "host" ? `Set on ${remoteHostName}` : `Set on ${deviceOwnerPhrase()}`;
}

/**
 * A row description with its owner appended in a remote window, matching the
 * description's own punctuation. The description, untouched, locally.
 */
export function useSettingsRowOwnerNote(): (
  description: string,
  owner: Exclude<SettingsOwner, "mixed">
) => string {
  const remoteHostName = useRemoteHostName();
  return (description, owner) => {
    const note = settingsRowOwnerNote(owner, remoteHostName);
    if (!note) return description;
    return description.endsWith(".") ? `${description} ${note}.` : `${description} · ${note}`;
  };
}

/** A forge with no credentials on the host the window works on; each host signs in on its own. */
export function forgeNotConnectedLabel(providerName: string, remoteHostName: string): string {
  return `${providerName} isn't connected on ${remoteHostName}`;
}
