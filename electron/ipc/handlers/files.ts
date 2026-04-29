import path from "path";
import fs from "fs/promises";
import { CHANNELS } from "../channels.js";
import { checkRateLimit, typedHandle } from "../utils.js";
import { fileSearchService } from "../../services/FileSearchService.js";
import { FileSearchPayloadSchema, FileReadPayloadSchema } from "../../schemas/ipc.js";
import type { FileReadResult } from "../../../shared/types/ipc/files.js";
import { AppError } from "../../utils/errorTypes.js";

const FILE_SIZE_LIMIT = 512 * 1024; // 500 KB

// Git LFS pointer files are plain ASCII with a fixed v1 header. The spec caps
// pointer files at 1024 bytes total, so any larger file cannot be a pointer.
// See https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md
const LFS_POINTER_MAX_SIZE = 1024;
const LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1\n";
const LFS_POINTER_HEADER_BYTES = Buffer.from(LFS_POINTER_HEADER, "ascii");

export function registerFilesHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleSearch = async (payload: unknown): Promise<{ files: string[] }> => {
    checkRateLimit(CHANNELS.FILES_SEARCH, 20, 10_000);

    const parsed = FileSearchPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[IPC] Invalid files:search payload:", parsed.error.format());
      return { files: [] };
    }

    const { cwd, query, limit } = parsed.data;

    if (!path.isAbsolute(cwd)) {
      return { files: [] };
    }

    try {
      const files = await fileSearchService.search({ cwd, query, limit });
      return { files };
    } catch (error) {
      console.error("[IPC] files:search failed:", error);
      return { files: [] };
    }
  };

  handlers.push(typedHandle(CHANNELS.FILES_SEARCH, handleSearch));

  const handleRead = async (payload: unknown): Promise<FileReadResult> => {
    const parsed = FileReadPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      console.error("[IPC] Invalid files:read payload:", parsed.error.format());
      throw new AppError({ code: "INVALID_PATH", message: "Invalid files:read payload" });
    }

    const { path: filePath, rootPath } = parsed.data;

    if (!path.isAbsolute(filePath) || !path.isAbsolute(rootPath)) {
      throw new AppError({
        code: "INVALID_PATH",
        message: "filePath and rootPath must be absolute",
        context: { filePath, rootPath },
      });
    }

    // Containment check: file must be inside rootPath
    const normalizedFile = path.normalize(filePath);
    const normalizedRoot = path.normalize(rootPath);
    if (
      !normalizedFile.startsWith(normalizedRoot + path.sep) &&
      normalizedFile !== normalizedRoot
    ) {
      throw new AppError({
        code: "OUTSIDE_ROOT",
        message: "File is outside the project root",
        context: { filePath, rootPath },
      });
    }

    // Map ENOENT/EACCES/EPERM the same way for both stat and readFile — the
    // file can disappear or change permissions between the two calls (TOCTOU).
    function fsErrorToAppError(error: unknown, fallbackMessage: string): AppError {
      const errCode = (error as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        return new AppError({
          code: "NOT_FOUND",
          message: "File not found",
          context: { filePath },
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (errCode === "EACCES" || errCode === "EPERM") {
        return new AppError({
          code: "PERMISSION",
          message: "Permission denied",
          userMessage: "You don't have permission to read this file.",
          context: { filePath },
          cause: error instanceof Error ? error : undefined,
        });
      }
      console.error("[IPC] files:read failed:", error);
      return new AppError({
        code: "INVALID_PATH",
        message: fallbackMessage,
        context: { filePath },
        cause: error instanceof Error ? error : undefined,
      });
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(normalizedFile);
    } catch (error) {
      throw fsErrorToAppError(error, "Could not stat file");
    }

    if (stat.size > FILE_SIZE_LIMIT) {
      throw new AppError({
        code: "FILE_TOO_LARGE",
        message: `File exceeds ${FILE_SIZE_LIMIT} byte limit`,
        userMessage: "This file is too large to preview.",
        context: { filePath, size: stat.size, limit: FILE_SIZE_LIMIT },
      });
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(normalizedFile);
    } catch (error) {
      throw fsErrorToAppError(error, "Could not read file");
    }

    // Binary detection: check for null bytes in first 8 KB
    const checkLength = Math.min(buffer.length, 8192);
    for (let i = 0; i < checkLength; i++) {
      if (buffer[i] === 0) {
        throw new AppError({
          code: "BINARY_FILE",
          message: "Binary file cannot be displayed as text",
          context: { filePath },
        });
      }
    }

    if (isLfsPointer(buffer)) {
      throw new AppError({
        code: "LFS_POINTER",
        message: "File is a Git LFS pointer",
        userMessage: "This file is stored in Git LFS — fetch it locally to preview.",
        context: { filePath },
      });
    }

    return { content: buffer.toString("utf-8") };
  };

  handlers.push(typedHandle(CHANNELS.FILES_READ, handleRead));

  return () => handlers.forEach((cleanup) => cleanup());
}

/**
 * Matches a Git LFS v1 pointer stub. Pointers are ASCII and capped at 1024 bytes
 * by the LFS spec; anything larger cannot be a pointer. Detection must happen
 * before `buffer.toString("utf-8")` so the text isn't surfaced to the UI.
 */
export function isLfsPointer(buffer: Buffer): boolean {
  if (buffer.length > LFS_POINTER_MAX_SIZE) return false;
  if (buffer.length < LFS_POINTER_HEADER_BYTES.length) return false;
  return buffer.subarray(0, LFS_POINTER_HEADER_BYTES.length).equals(LFS_POINTER_HEADER_BYTES);
}
