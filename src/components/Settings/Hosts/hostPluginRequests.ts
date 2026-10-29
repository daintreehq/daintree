import { isValidRemoteHostId, type HostId } from "@shared/types/remoteHosts";
import type { SettingsNavTarget } from "@/components/Settings";
import { HOSTS_SETTINGS_TAB } from "@/components/Hosts/hostModel";

type Listener = (hostId: HostId) => void;

const listeners = new Set<Listener>();
let pending: HostId | null = null;

/**
 * Ask Settings → Hosts to show one host's plugins. Answered at once when the
 * tab is showing; otherwise held until it mounts, since the request is what
 * opens it.
 */
export function requestHostPlugins(hostId: HostId): void {
  if (listeners.size === 0) {
    pending = hostId;
    return;
  }
  pending = null;
  for (const listener of [...listeners]) listener(hostId);
}

/** The request made before the tab was showing, if any; taking it clears it. */
export function takePendingHostPlugins(): HostId | null {
  const hostId = pending;
  pending = null;
  return hostId;
}

export function onHostPluginsRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The section of a host's details that lists its plugins. */
export const HOST_PLUGINS_SECTION_ID = "host-plugins";

/**
 * Settings → Hosts on one host's plugins, as a target `app.settings.openTab`
 * takes. A notice's button needs this form to work from the inbox, which keeps
 * an action's id and args but never its callback.
 */
export function hostPluginsSettingsTarget(hostId: HostId) {
  return {
    tab: HOSTS_SETTINGS_TAB,
    subtab: hostId,
    sectionId: HOST_PLUGINS_SECTION_ID,
  } satisfies SettingsNavTarget;
}

/** The host whose plugins a settings target asks for, or null when it asks for anything else. */
export function hostPluginsTargetHost(target: SettingsNavTarget): HostId | null {
  if (target.tab !== HOSTS_SETTINGS_TAB || target.sectionId !== HOST_PLUGINS_SECTION_ID) {
    return null;
  }
  const hostId = target.subtab;
  return hostId !== undefined && isValidRemoteHostId(hostId) ? hostId : null;
}
