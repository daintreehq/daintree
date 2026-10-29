import { isValidRemoteHostId, type HostId } from "@shared/types/remoteHosts";
import type { SettingsNavTarget } from "@/components/Settings";
import { HOSTS_SETTINGS_TAB } from "@/components/Hosts/hostModel";

/** The section of a host's details that lists its plugins. */
export const HOST_PLUGINS_SECTION_ID = "host-plugins";
/** The section of a host's details that lists this computer's answers about its plugin views. */
export const HOST_PLUGIN_VIEWS_SECTION_ID = "host-plugin-views";

export type HostPluginsSectionId =
  | typeof HOST_PLUGINS_SECTION_ID
  | typeof HOST_PLUGIN_VIEWS_SECTION_ID;

export interface HostPluginsRequest {
  hostId: HostId;
  sectionId: HostPluginsSectionId;
}

type Listener = (request: HostPluginsRequest) => void;

const listeners = new Set<Listener>();
let pending: HostPluginsRequest | null = null;

/**
 * Ask Settings → Hosts to show one host's plugins, or this computer's answers
 * about their views. Answered at once when the tab is showing; otherwise held
 * until it mounts, since the request is what opens it.
 */
export function requestHostPlugins(
  hostId: HostId,
  sectionId: HostPluginsSectionId = HOST_PLUGINS_SECTION_ID
): void {
  const request = { hostId, sectionId };
  if (listeners.size === 0) {
    pending = request;
    return;
  }
  pending = null;
  for (const listener of [...listeners]) listener(request);
}

/** The request made before the tab was showing, if any; taking it clears it. */
export function takePendingHostPlugins(): HostPluginsRequest | null {
  const request = pending;
  pending = null;
  return request;
}

export function onHostPluginsRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Settings → Hosts on one host's plugins (or their views), as a target
 * `app.settings.openTab` takes. A notice's button needs this form to work from
 * the inbox, which keeps an action's id and args but never its callback.
 */
export function hostPluginsSettingsTarget(
  hostId: HostId,
  sectionId: HostPluginsSectionId = HOST_PLUGINS_SECTION_ID
) {
  return {
    tab: HOSTS_SETTINGS_TAB,
    subtab: hostId,
    sectionId,
  } satisfies SettingsNavTarget;
}

function isHostPluginsSectionId(sectionId: string | undefined): sectionId is HostPluginsSectionId {
  return sectionId === HOST_PLUGINS_SECTION_ID || sectionId === HOST_PLUGIN_VIEWS_SECTION_ID;
}

/** The host and section a settings target asks for, or null when it asks for anything else. */
export function hostPluginsTargetRequest(target: SettingsNavTarget): HostPluginsRequest | null {
  const { sectionId } = target;
  if (target.tab !== HOSTS_SETTINGS_TAB || !isHostPluginsSectionId(sectionId)) return null;
  const hostId = target.subtab;
  return hostId !== undefined && isValidRemoteHostId(hostId) ? { hostId, sectionId } : null;
}
