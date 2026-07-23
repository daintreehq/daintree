import type { SpawnError, SpawnErrorCode } from "../../shared/types/pty-host.js";

export function parseSpawnError(error: unknown): SpawnError {
  if (error instanceof Error) {
    const nodeErr = error as NodeJS.ErrnoException;

    let code: SpawnErrorCode = "UNKNOWN";
    if (nodeErr.code === "ENOENT") {
      code = "ENOENT";
    } else if (nodeErr.code === "EACCES") {
      code = "EACCES";
    } else if (nodeErr.code === "ENOTDIR") {
      code = "ENOTDIR";
    } else if (nodeErr.code === "EIO") {
      code = "EIO";
    } else if (nodeErr.code === "EMFILE") {
      code = "EMFILE";
    } else if (nodeErr.code === "EAGAIN") {
      code = "EAGAIN";
    } else if (nodeErr.code === "ENOMEM") {
      code = "ENOMEM";
    } else if (nodeErr.code === "ENXIO") {
      code = "ENXIO";
    } else if (nodeErr.code === "EBUSY") {
      code = "EBUSY";
    } else if (nodeErr.code === "TERMINAL_ALREADY_LIVE") {
      // Custom, non-errno code thrown by PtyManager.spawn() when the id already
      // has a live owner (#11341). Preserved explicitly rather than by casting
      // an arbitrary runtime string, so an unrelated code can't slip into the
      // closed SpawnErrorCode union and break the renderer banner lookup.
      code = "TERMINAL_ALREADY_LIVE";
    }

    return {
      code,
      message: nodeErr.message,
      errno: nodeErr.errno,
      syscall: nodeErr.syscall,
      path: nodeErr.path,
    };
  }

  return {
    code: "UNKNOWN",
    message: String(error),
  };
}
