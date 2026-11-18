import type { FileReadErrorCode } from "@shared/types/ipc/files";
import { isClientAppError } from "@/utils/clientAppError";

/** User-facing messages for files.read failures — shared by the file viewer modal and the markdown panel. */
export const FILE_READ_ERROR_MESSAGES: Record<FileReadErrorCode, string> = {
  BINARY_FILE: "Binary file — cannot display",
  FILE_TOO_LARGE: "File too large to display as text (> 500 KB)",
  LFS_POINTER: "Git LFS pointer — run `git lfs pull` to download the file contents",
  NOT_FOUND: "File no longer exists",
  OUTSIDE_ROOT: "File is outside the project root",
  INVALID_PATH: "Invalid file path",
  NOT_A_FILE: "This is a folder, not a file",
  PERMISSION: "Permission denied — you don't have access to this file",
};

function isFileReadErrorCode(code: string): code is FileReadErrorCode {
  return Object.hasOwn(FILE_READ_ERROR_MESSAGES, code);
}

/** Narrow an untrusted error code from the IPC boundary; unknown codes map to INVALID_PATH. */
export function toFileReadErrorCode(code: unknown): FileReadErrorCode {
  return typeof code === "string" && isFileReadErrorCode(code) ? code : "INVALID_PATH";
}

/**
 * The size a read refused the file at for being too large, or null when the
 * failure was something else or the host didn't say (an older one).
 */
export function refusedFileSize(error: unknown): number | null {
  if (!isClientAppError(error) || error.code !== "FILE_TOO_LARGE") return null;
  return error.details?.code === "FILE_TOO_LARGE" ? error.details.sizeBytes : null;
}
