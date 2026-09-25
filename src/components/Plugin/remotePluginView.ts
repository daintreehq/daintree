import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { toRemotePluginViewUrl } from "@shared/types/pluginRemoteView";

/** The remote host this view runs on, or null when it runs on this machine. */
export function pluginViewHostId(): string | null {
  if (typeof window === "undefined") return null;
  const id = window.__DAINTREE_HOST_ID__?.id;
  return typeof id === "string" && id !== LOCAL_HOST_ID ? id : null;
}

/**
 * The URL a plugin view module is imported from. In a window attached to
 * another machine the module lives on that host, so its URL names the host and
 * this machine fetches it from there; a local view's URL is unchanged.
 */
export function pluginViewImportPath(componentPath: string): string {
  const hostId = pluginViewHostId();
  return hostId === null ? componentPath : toRemotePluginViewUrl(componentPath, hostId);
}

/**
 * The host refused to start the plugin for this window because the plugin
 * declares `"remote": "unsupported"`.
 */
export function isRemoteUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") return false;
  const { code, reason } = details as { code?: unknown; reason?: { kind?: unknown } };
  return code === "PLUGIN_INCOMPATIBLE" && reason?.kind === "remote-unsupported";
}
