import { isRemoteHostsSupportedOn } from "../../shared/config/remoteHostsSupport.js";

/**
 * The build define read defensively, so modules imported by tsx scripts (which
 * have no define) still load. Use the raw `__DAINTREE_REMOTE_HOSTS__`
 * identifier at sites that dynamically import remote modules; this value is
 * for runtime checks only and does not tree-shake across modules.
 */
export const REMOTE_HOSTS_BUILD_ENABLED: boolean =
  typeof __DAINTREE_REMOTE_HOSTS__ === "boolean" ? __DAINTREE_REMOTE_HOSTS__ : true;

export const BUILD_COMMIT: string =
  typeof __DAINTREE_BUILD_COMMIT__ === "string" ? __DAINTREE_BUILD_COMMIT__ : "unknown";

/** The single runtime gate for Remote Hosts in the main process. */
export function isRemoteHostsSupported(): boolean {
  return isRemoteHostsSupportedOn(process.platform, REMOTE_HOSTS_BUILD_ENABLED);
}
