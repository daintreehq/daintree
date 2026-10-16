/**
 * Remote Hosts has two roles, gated apart so each can open up on its own.
 *
 * - **Shell**: this machine drives other hosts (the host chip and menu,
 *   Settings → Hosts, switching, the link client).
 * - **Host**: other machines drive this one (Host mode's listener, start at
 *   login, `--attach-stdio`).
 *
 * Every platform can be a Shell. Only macOS and Linux can be a Host: a
 * Windows Shell drives Linux Hosts inside WSL distros on the same PC (#12830).
 */
export function isRemoteShellSupportedOn(_platform: string, buildEnabled: boolean): boolean {
  return buildEnabled;
}

export function isRemoteHostSupportedOn(platform: string, buildEnabled: boolean): boolean {
  return buildEnabled && platform !== "win32";
}

/** Either role: for what both need (the IPC namespaces, the boot that starts both). */
export function isEitherRemoteRoleSupportedOn(platform: string, buildEnabled: boolean): boolean {
  return (
    isRemoteShellSupportedOn(platform, buildEnabled) ||
    isRemoteHostSupportedOn(platform, buildEnabled)
  );
}

/** How hosts are reached: `HostConnection["kind"]`, kept here so this module stays dependency-free. */
export type RemoteConnectionKind = "ssh" | "wsl";

/**
 * The one kind of host a Shell on this platform reaches: Linux Hosts in WSL
 * distros on Windows, ssh everywhere else. Windows' OpenSSH has no
 * ControlMaster, which the ssh transport is built on.
 */
export function remoteConnectionKindOn(platform: string): RemoteConnectionKind {
  return platform === "win32" ? "wsl" : "ssh";
}
