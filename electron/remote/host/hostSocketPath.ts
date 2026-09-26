import path from "node:path";

/**
 * Where Host mode listens. macOS keeps the socket in the app's userData
 * directory; Linux uses the per-user runtime directory, derived from the uid
 * because minimal SSH sessions often don't export XDG_RUNTIME_DIR. The
 * discovery file sits next to the socket so a client that can derive one can
 * derive the other.
 */

export const HOST_SOCKET_NAME = "host.sock";
export const HOST_DISCOVERY_NAME = "host.json";
export const LINUX_RUNTIME_DIR_NAME = "daintree";
/** The production app's userData directory name under ~/Library/Application Support. */
export const MAC_APP_DIR_NAME = "Daintree";

export type SocketPlatform = "darwin" | "linux";

/** `sun_path` capacity including the terminating NUL. */
const SUN_PATH_BYTES: Record<SocketPlatform, number> = { darwin: 104, linux: 108 };

export interface HostSocketLocation {
  dir: string;
  socketPath: string;
  discoveryPath: string;
}

export function linuxRuntimeDir(uid: number): string {
  return `/run/user/${uid}`;
}

export function hostSocketLocation(
  params:
    | { platform: "darwin"; userDataDir: string }
    | { platform: "linux"; uid: number; dirName?: string }
): HostSocketLocation {
  const dir =
    params.platform === "darwin"
      ? params.userDataDir
      : path.posix.join(linuxRuntimeDir(params.uid), params.dirName ?? LINUX_RUNTIME_DIR_NAME);
  return {
    dir,
    socketPath: path.posix.join(dir, HOST_SOCKET_NAME),
    discoveryPath: path.posix.join(dir, HOST_DISCOVERY_NAME),
  };
}

/**
 * The same location as seen from a client that only knows the remote's
 * `uname -s`, uid and $HOME. Assumes the packaged app's directory names.
 */
export function remoteHostSocketLocation(params: {
  platform: SocketPlatform;
  uid: number;
  home: string;
  macAppDirName?: string;
  linuxDirName?: string;
}): HostSocketLocation {
  if (params.platform === "darwin") {
    return hostSocketLocation({
      platform: "darwin",
      userDataDir: path.posix.join(
        params.home,
        "Library",
        "Application Support",
        params.macAppDirName ?? MAC_APP_DIR_NAME
      ),
    });
  }
  return hostSocketLocation({ platform: "linux", uid: params.uid, dirName: params.linuxDirName });
}

export class SocketPathTooLongError extends Error {
  constructor(
    readonly socketPath: string,
    readonly limit: number
  ) {
    super(
      `Socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${limit}-byte limit: ${socketPath}`
    );
    this.name = "SocketPathTooLongError";
  }
}

/** Throw a clear error instead of letting bind fail (or silently truncate) on a long path. */
export function assertSocketPathFits(
  socketPath: string,
  platform: NodeJS.Platform = process.platform
): void {
  const limit = SUN_PATH_BYTES[platform === "linux" ? "linux" : "darwin"] - 1;
  if (Buffer.byteLength(socketPath) > limit) throw new SocketPathTooLongError(socketPath, limit);
}

export function maxSocketPathBytes(platform: NodeJS.Platform = process.platform): number {
  return SUN_PATH_BYTES[platform === "linux" ? "linux" : "darwin"] - 1;
}
