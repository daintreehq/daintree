import { isRemoteHostsSupportedOn } from "@shared/config/remoteHostsSupport";
import { isWindows } from "./platform";

const BUILD_ENABLED: boolean =
  typeof __DAINTREE_REMOTE_HOSTS__ === "boolean" ? __DAINTREE_REMOTE_HOSTS__ : true;

/**
 * The single renderer gate for Remote Hosts: the host chip, the host menu,
 * Settings → Hosts and the host actions render and register only when this is
 * true. The client's own platform decides, since a Windows client can neither
 * host nor connect.
 */
export function isRemoteHostsSupported(): boolean {
  return isRemoteHostsSupportedOn(isWindows() ? "win32" : "posix", BUILD_ENABLED);
}
