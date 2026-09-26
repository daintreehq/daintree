import {
  isEitherRemoteRoleSupportedOn,
  isRemoteHostSupportedOn,
  isRemoteShellSupportedOn,
} from "../../shared/config/remoteHostsSupport.js";

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

/** This machine can drive other hosts (the link client, host switching, setup). */
export function isRemoteShellSupported(): boolean {
  return isRemoteShellSupportedOn(process.platform, REMOTE_HOSTS_BUILD_ENABLED);
}

/** Other machines can drive this one (Host mode, start at login, `--attach-stdio`). */
export function isRemoteHostSupported(): boolean {
  return isRemoteHostSupportedOn(process.platform, REMOTE_HOSTS_BUILD_ENABLED);
}

/** Either role: the Remote Hosts IPC namespaces and the boot that starts both sides. */
export function isEitherRemoteRoleSupported(): boolean {
  return isEitherRemoteRoleSupportedOn(process.platform, REMOTE_HOSTS_BUILD_ENABLED);
}
