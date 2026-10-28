import path from "path";
import fs from "fs/promises";
import { isUtf8 } from "node:buffer";
import { CHANNELS } from "../channels.js";
import { checkRateLimit, typedHandleWithContextValidated } from "../utils.js";
import type { IpcContext } from "../types.js";
import { getRemoteService } from "../../remote/runtime.js";
import { fileSearchService } from "../../services/FileSearchService.js";
import { buildHtmlPreviewUrl } from "../../setup/htmlPreviewTokens.js";
import {
  FileSearchPayloadSchema,
  FileReadPayloadSchema,
  type FileSearchPayload,
  type FileReadPayload,
} from "../../schemas/ipc.js";
import type { FileReadResult } from "../../../shared/types/ipc/files.js";
import type { UploadIdentity } from "../../remote/files/HostFileService.js";
import { AppError } from "../../utils/errorTypes.js";
import { readBoundedFromHandle } from "../../utils/boundedRead.js";
import { FILE_PREVIEW_MAX_BYTES } from "../../utils/fileLimits.js";

// Git LFS pointer files are plain ASCII with a fixed v1 header. The spec caps
// pointer files at 1024 bytes total, so any larger file cannot be a pointer.
// See https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md
const LFS_POINTER_MAX_SIZE = 1024;
const LFS_POINTER_HEADER = "version https://git-lfs.github.com/spec/v1\n";
const LFS_POINTER_HEADER_BYTES = Buffer.from(LFS_POINTER_HEADER, "ascii");

/**
 * A local view may name any root, as it always could. A remote Shell's view
 * may only name its own project's folder or one of its worktrees (or a folder
 * inside one), so the link can't be used to read the rest of this machine.
 * Fails closed when the host's file service isn't running.
 */
export async function remoteCallerHoldsRoot(ctx: IpcContext, root: string): Promise<boolean> {
  if (ctx.endpoint?.kind !== "remote-view") return true;
  const projectId = ctx.endpoint.projectId;
  const files = getRemoteService("hostFileService");
  if (!projectId || !files) return false;
  return files.holdsRoot(projectId, root);
}

/**
 * A remote Shell's view reading a file it uploaded into this host's inbox
 * itself, from that file's own folder: the identity it was placed as, or null.
 * The inbox holds every Shell's uploads, so this is that one file, never the
 * folder: the read below still has to resolve to a file inside the folder, and
 * the descriptor it opens has to be the file the view placed.
 */
export async function remoteCallerUpload(
  ctx: IpcContext,
  filePath: string,
  root: string
): Promise<UploadIdentity | null> {
  if (ctx.endpoint?.kind !== "remote-view" || !ctx.endpoint.projectId) return null;
  const files = getRemoteService("hostFileService");
  if (!files || path.dirname(path.resolve(filePath)) !== path.resolve(root)) return null;
  return files.uploadIdentity(ctx.endpoint, filePath);
}

/**
 * A remote Shell's view reading a file the person clicked a link to in one of
 * its terminals, from that file's own folder. Both are named plainly, with no
 * `.` or `..`, and the root exactly as the file's folder is spelled: the grant
 * is matched by spelling, and realpath would otherwise walk a `..` after a
 * symlinked folder somewhere else. The read below still has to land on that
 * file itself, not a link in its place.
 */
export function remoteCallerClicked(ctx: IpcContext, filePath: string, root: string): boolean {
  if (ctx.endpoint?.kind !== "remote-view" || !ctx.endpoint.projectId) return false;
  const files = getRemoteService("hostFileService");
  if (!files || path.normalize(filePath) !== filePath) return false;
  const folder = root.length > 1 ? root.replace(/\/+$/, "") : root;
  if (folder !== path.dirname(filePath)) return false;
  return files.isClicked(ctx.endpoint, filePath);
}

/** The opened descriptor is the upload as it was placed: compared as bigints, so no inode loses precision. */
async function isPlacedUpload(
  handle: Awaited<ReturnType<typeof fs.open>>,
  placed: UploadIdentity
): Promise<boolean> {
  const now = await handle.stat({ bigint: true });
  return (
    BigInt(now.dev) === placed.dev &&
    BigInt(now.ino) === placed.ino &&
    BigInt(now.size) === placed.size
  );
}

export function registerFilesHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleSearch = async (
    ctx: IpcContext,
    { cwd, query, limit }: FileSearchPayload
  ): Promise<{ files: string[] }> => {
    checkRateLimit(CHANNELS.FILES_SEARCH, 20, 10_000);

    if (!path.isAbsolute(cwd)) {
      return { files: [] };
    }
    if (!(await remoteCallerHoldsRoot(ctx, cwd))) {
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

  handlers.push(
    typedHandleWithContextValidated(CHANNELS.FILES_SEARCH, FileSearchPayloadSchema, handleSearch)
  );

  const handleRead = async (
    ctx: IpcContext,
    { path: filePath, rootPath, htmlPreview }: FileReadPayload
  ): Promise<FileReadResult> => {
    if (!path.isAbsolute(filePath) || !path.isAbsolute(rootPath)) {
      throw new AppError({
        code: "INVALID_PATH",
        message: "filePath and rootPath must be absolute",
        context: { filePath, rootPath },
      });
    }
    let ownUpload: UploadIdentity | null = null;
    let clicked = false;
    if (!(await remoteCallerHoldsRoot(ctx, rootPath))) {
      ownUpload = await remoteCallerUpload(ctx, filePath, rootPath);
      clicked = ownUpload === null && remoteCallerClicked(ctx, filePath, rootPath);
      if (!ownUpload && !clicked) {
        throw new AppError({
          code: "OUTSIDE_ROOT",
          message: "Root is outside the calling view's project",
          context: { rootPath },
        });
      }
    }

    // Map fs errors uniformly across realpath/stat/open — the file can
    // disappear or change permissions between calls (TOCTOU). ELOOP surfaces
    // from circular symlinks (realpath) or O_NOFOLLOW final-component
    // symlink rejection (open); both are containment failures.
    function fsErrorToAppError(error: unknown, fallbackMessage: string): AppError {
      // A refusal already decided here keeps its own code.
      if (error instanceof AppError) return error;
      const errCode = (error as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        return new AppError({
          code: "NOT_FOUND",
          message: "File not found",
          context: { filePath },
          cause: error instanceof Error ? error : undefined,
        });
      }
      if (errCode === "ELOOP") {
        return new AppError({
          code: "OUTSIDE_ROOT",
          message: "File is outside the project root",
          context: { filePath, rootPath },
          cause: error instanceof Error ? error : undefined,
        });
      }
      // A submodule gitlink's path is the submodule's own checkout, so the diff
      // and file panels can arrive here aimed at a directory. `open` succeeds on
      // one; `readFile` is what fails, with EISDIR on all three platforms. Left
      // to the fallback it was reported as an invalid path (#12309).
      if (errCode === "EISDIR") {
        return new AppError({
          code: "NOT_A_FILE",
          message: "Path is a directory, not a file",
          userMessage: "This is a folder, not a file.",
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

    // Canonicalize root via OS-level resolution. A missing root is a caller
    // configuration error, not a "file not found" — surface it as INVALID_PATH
    // rather than letting fsErrorToAppError downgrade it to NOT_FOUND.
    let realRoot: string;
    try {
      realRoot = await fs.realpath(rootPath);
    } catch (error) {
      const errCode = (error as NodeJS.ErrnoException).code;
      if (errCode === "ENOENT") {
        throw new AppError({
          code: "INVALID_PATH",
          message: "Project root does not exist",
          context: { rootPath },
          cause: error instanceof Error ? error : undefined,
        });
      }
      throw fsErrorToAppError(error, "Could not resolve project root");
    }

    let realFile: string;
    try {
      realFile = await fs.realpath(filePath);
    } catch (error) {
      throw fsErrorToAppError(error, "Could not resolve file path");
    }

    // Root === path.sep (POSIX "/") is a degenerate case: realRoot + path.sep
    // becomes "//", which never prefix-matches a real path. Treat any absolute
    // file as contained when the root is the filesystem root.
    const contained =
      realRoot === path.sep
        ? realFile.startsWith(path.sep)
        : realFile === realRoot || realFile.startsWith(realRoot + path.sep);
    // A clicked file's root is its own folder, so a link in its place to a
    // file beside it would still be contained.
    if (!contained || (clicked && realFile !== path.join(realRoot, path.basename(filePath)))) {
      throw new AppError({
        code: "OUTSIDE_ROOT",
        message: "File is outside the project root",
        context: { filePath, rootPath },
      });
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(realFile);
    } catch (error) {
      throw fsErrorToAppError(error, "Could not stat file");
    }

    if (stat.size > FILE_PREVIEW_MAX_BYTES) {
      throw new AppError({
        code: "FILE_TOO_LARGE",
        message: `File exceeds ${FILE_PREVIEW_MAX_BYTES} byte limit`,
        userMessage: "This file is too large to preview.",
        context: { filePath, size: stat.size, limit: FILE_PREVIEW_MAX_BYTES },
      });
    }

    // Open the contained realFile, not the path as asked, with O_NOFOLLOW: a
    // link inside the project resolves to a real path that was just checked,
    // while a link swapped in for that path after the check is rejected with
    // ELOOP. Opening the asked path refused every symlinked file, in-project
    // ones included. On Windows O_NOFOLLOW is 0 (no-op); realpath containment
    // still applies.
    // O_NONBLOCK so a FIFO swapped in can't hang the open (and a libuv worker
    // with it); the descriptor is then held to what was checked: a regular
    // file, in budget, the very file the contained real path names.
    let buffer: Buffer;
    let fileHandle: Awaited<ReturnType<typeof fs.open>>;
    try {
      fileHandle = await fs.open(
        realFile,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)
      );
    } catch (error) {
      throw fsErrorToAppError(error, "Could not open file");
    }
    try {
      const opened = await fileHandle.stat();
      if (opened.isDirectory()) {
        throw Object.assign(new Error("Path is a directory"), { code: "EISDIR" });
      }
      if (!opened.isFile()) {
        throw new AppError({
          code: "NOT_A_FILE",
          message: "Path is not a regular file",
          userMessage: "This isn't a file that can be previewed.",
          context: { filePath },
        });
      }
      if (opened.size > FILE_PREVIEW_MAX_BYTES) {
        throw new AppError({
          code: "FILE_TOO_LARGE",
          message: `File exceeds ${FILE_PREVIEW_MAX_BYTES} byte limit`,
          userMessage: "This file is too large to preview.",
          context: { filePath, size: opened.size, limit: FILE_PREVIEW_MAX_BYTES },
        });
      }
      if (String(opened.ino) !== String(stat.ino) || String(opened.dev) !== String(stat.dev)) {
        throw new AppError({
          code: "OUTSIDE_ROOT",
          message: "The file changed while it was being opened",
          context: { filePath, rootPath },
        });
      }
      if (ownUpload && !(await isPlacedUpload(fileHandle, ownUpload))) {
        throw new AppError({
          code: "OUTSIDE_ROOT",
          message: "The upload is no longer the file this view placed",
          context: { filePath, rootPath },
        });
      }
      // The stat above is only a hint: a writer can grow the file after it, so
      // the read itself holds the budget and never returns oversized text.
      const read = await readBoundedFromHandle(fileHandle, opened.size, FILE_PREVIEW_MAX_BYTES);
      if (read === null) {
        throw new AppError({
          code: "FILE_TOO_LARGE",
          message: `File exceeds ${FILE_PREVIEW_MAX_BYTES} byte limit`,
          userMessage: "This file is too large to preview.",
          context: { filePath, limit: FILE_PREVIEW_MAX_BYTES },
        });
      }
      // A grant rests on the lease, which may have moved while this read ran.
      if (clicked && !remoteCallerClicked(ctx, filePath, rootPath)) {
        throw new AppError({
          code: "OUTSIDE_ROOT",
          message: "The view lost control of the project while reading",
          context: { filePath, rootPath },
        });
      }
      buffer = read;
    } catch (error) {
      throw fsErrorToAppError(error, "Could not read file");
    } finally {
      // Swallow close errors so they don't mask a preceding readFile failure.
      await fileHandle.close().catch(() => {});
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

    // #11191: on opt-in, mint a sandboxed-iframe preview URL for HTML files. The
    // token maps to the canonical root; the daintree-html:// handler re-applies
    // full containment, so this never widens access. realRoot/realFile are
    // already realpath-resolved and contained above. Never for an upload or a
    // clicked file: the root is the file's own folder, which a token would open
    // in whole.
    const htmlPreviewUrl =
      htmlPreview && ownUpload === null && !clicked && /\.html?$/i.test(realFile)
        ? (buildHtmlPreviewUrl(realRoot, realFile) ?? undefined)
        : undefined;

    const hasBom =
      buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    return {
      content: buffer.toString("utf-8"),
      encoding: !isUtf8(buffer) ? "invalid" : hasBom ? "utf-8-bom" : "utf-8",
      byteLength: buffer.length,
      htmlPreviewUrl,
      // A hard-linked file has more than one real path, and a directory watch
      // only reports the name it was written through.
      pathIsCanonical: realFile === path.resolve(filePath) && !(stat.nlink > 1),
    };
  };

  handlers.push(
    typedHandleWithContextValidated(CHANNELS.FILES_READ, FileReadPayloadSchema, handleRead)
  );

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
