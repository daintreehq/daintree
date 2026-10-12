import {
  isEitherRemoteRoleSupportedOn,
  isRemoteHostSupportedOn,
  isRemoteShellSupportedOn,
} from "@shared/config/remoteHostsSupport";
import { isWindows } from "./platform";

const BUILD_ENABLED: boolean =
  typeof __DAINTREE_REMOTE_HOSTS__ === "boolean" ? __DAINTREE_REMOTE_HOSTS__ : true;

const clientPlatform = () => (isWindows() ? "win32" : "posix");

/**
 * This machine drives other hosts: the host chip, the host menu, Settings →
 * Hosts, switching and the host actions render and register only when this is
 * true. The client's own platform decides.
 */
export function isRemoteShellSupported(): boolean {
  return isRemoteShellSupportedOn(clientPlatform(), BUILD_ENABLED);
}

/** Other machines drive this one: the Host mode switch and its status. */
export function isRemoteHostSupported(): boolean {
  return isRemoteHostSupportedOn(clientPlatform(), BUILD_ENABLED);
}

/** Either role: what both sides show, such as the drive lease a project is under. */
export function isEitherRemoteRoleSupported(): boolean {
  return isEitherRemoteRoleSupportedOn(clientPlatform(), BUILD_ENABLED);
}
