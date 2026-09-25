import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { toRemotePluginViewUrl } from "@shared/types/pluginRemoteView";
import { isClientAppError } from "@/utils/clientAppError";

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
  const details = hostErrorDetails(error);
  if (!details) return false;
  const { code, reason } = details as { code?: unknown; reason?: { kind?: unknown } };
  return code === "PLUGIN_INCOMPATIBLE" && reason?.kind === "remote-unsupported";
}

/**
 * The typed details of a host's plugin refusal. An error that crossed the
 * contextBridge carries them only in its message prefix, which the guard
 * decodes back onto the error.
 */
function hostErrorDetails(error: unknown): object | null {
  if (!error || typeof error !== "object") return null;
  if (error instanceof Error) isClientAppError(error);
  const details = (error as { details?: unknown }).details;
  return details && typeof details === "object" ? details : null;
}

/**
 * The host this window is attached to doesn't have the plugin (any more): a
 * call to it, or its view's activation, came back as `PLUGIN_NOT_ON_HOST`.
 */
export function isPluginNotOnHostError(error: unknown): boolean {
  return (hostErrorDetails(error) as { code?: unknown } | null)?.code === "PLUGIN_NOT_ON_HOST";
}
