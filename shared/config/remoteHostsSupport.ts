/**
 * Remote Hosts has two roles, gated apart so each can open up on its own.
 *
 * - **Shell**: this machine drives other hosts (the host chip and menu,
 *   Settings → Hosts, switching, the link client).
 * - **Host**: other machines drive this one (Host mode's listener, start at
 *   login, `--attach-stdio`).
 *
 * Both are macOS and Linux only today, so a Windows build has neither. A
 * Windows Shell driving a Linux Host inside WSL (#12830) is the Shell gate
 * flipped for win32 plus the path work listed in
 * docs/architecture/remote-hosts.md; the Host gate stays off there.
 */
export function isRemoteShellSupportedOn(platform: string, buildEnabled: boolean): boolean {
  return buildEnabled && platform !== "win32";
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
