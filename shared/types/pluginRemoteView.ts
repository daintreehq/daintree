import { isValidRemoteHostId, type HostId } from "./remoteHosts.js";

/**
 * Reserved first path segment naming the host a `plugin://` asset lives on,
 * e.g. `plugin://pi-3f…/__dth-studio-01/__dtv-7/dist/view.js`.
 *
 * A window attached to another machine runs that machine's plugin views in
 * this machine's renderer. The authority in their URLs was minted by the host
 * and means nothing here, and a plugin id alias could even name a different
 * local copy of the same plugin — so the view's URL carries its host, and this
 * machine fetches the bytes from that host rather than from its own disk.
 * Relative imports inside the view resolve under the same segment, so a whole
 * view bundle stays on its host.
 */
export const PLUGIN_REMOTE_HOST_PREFIX = "__dth-";

/**
 * Put a `plugin://` URL on its host. Anything that isn't a well-formed
 * `plugin://` URL, or already names a host, is returned unchanged.
 */
export function toRemotePluginViewUrl(url: string, hostId: HostId): string {
  if (!isValidRemoteHostId(hostId)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "plugin:" || !parsed.hostname) return url;
  const rest = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;
  if (rest.length === 0 || rest.startsWith(PLUGIN_REMOTE_HOST_PREFIX)) return url;
  return `plugin://${parsed.hostname}/${PLUGIN_REMOTE_HOST_PREFIX}${hostId}/${rest}${parsed.search}`;
}

export interface RemotePluginAssetPath {
  hostId: HostId;
  /** The path on the host, still URL-encoded, with no leading slash. */
  path: string;
}

/**
 * Split a `plugin://` pathname into its host and the path on that host.
 * `null` for an asset of this machine's; `"malformed"` for a path that uses
 * the reserved segment without naming a valid host and a file, which must
 * never fall through to a local disk lookup.
 */
export function parseRemotePluginAssetPath(
  pathname: string
): RemotePluginAssetPath | null | "malformed" {
  const trimmed = pathname.startsWith("/") ? pathname.slice(1) : pathname;
  if (!trimmed.startsWith(PLUGIN_REMOTE_HOST_PREFIX)) return null;
  const slash = trimmed.indexOf("/");
  if (slash === -1) return "malformed";
  const hostId = trimmed.slice(PLUGIN_REMOTE_HOST_PREFIX.length, slash);
  const rest = trimmed.slice(slash + 1);
  if (!isValidRemoteHostId(hostId) || rest.length === 0) return "malformed";
  return { hostId, path: rest };
}
