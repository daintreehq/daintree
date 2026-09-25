/**
 * Remote Hosts runs on macOS and Linux, as hosts and as clients. Windows
 * builds have no host chip, no Hosts settings, no link and no host socket.
 */
export function isRemoteHostsSupportedOn(platform: string, buildEnabled: boolean): boolean {
  return buildEnabled && platform !== "win32";
}
