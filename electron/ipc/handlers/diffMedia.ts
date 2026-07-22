import path from "path";
import fs from "fs/promises";
import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import { DIFF_MEDIA_METHOD_CHANNELS } from "./diffMedia.preload.js";
import { isLfsPointer } from "./files.js";
import { DiffMediaReadFileVersionsPayloadSchema } from "../../schemas/ipc.js";
import { gitServiceCache } from "../../services/GitServiceCache.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  DIFF_MEDIA_MAX_BYTES,
  getDiffMediaImageMime,
  type DiffMediaFileVersions,
  type DiffMediaReadFileVersionsPayload,
  type DiffMediaSide,
} from "../../../shared/types/ipc/diffMedia.js";

function toImageSide(mime: string, content: Buffer): DiffMediaSide {
  // Git LFS pointer files are text stand-ins for the real blob — served as
  // image bytes they just render broken.
  if (isLfsPointer(content)) {
    return { ok: false, error: "UNSUPPORTED" };
  }
  return {
    ok: true,
    dataUrl: `data:${mime};base64,${content.toString("base64")}`,
    byteSize: content.byteLength,
  };
}

// Semantic path checks (absoluteness, traversal, null bytes) beyond the
// structural zod validation at the IPC boundary.
function validatePayload(payload: DiffMediaReadFileVersionsPayload): void {
  const { cwd, filePath } = payload;
  if (!path.isAbsolute(cwd)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "cwd must be an absolute path",
      context: { cwd },
    });
  }
  if (!filePath.trim()) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "filePath is required",
      context: { filePath },
    });
  }
  if (filePath.includes("\0")) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "filePath contains null bytes",
      context: {},
    });
  }
  if (path.isAbsolute(filePath)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "filePath must be relative to cwd",
      context: { filePath },
    });
  }
  const normalized = path.normalize(filePath);
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  if (segments.includes("..") || normalized.startsWith(path.sep)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "Path traversal detected",
      context: { filePath },
    });
  }
}

async function readHeadSide(cwd: string, filePath: string, mime: string): Promise<DiffMediaSide> {
  try {
    const gitService = gitServiceCache.getGitService(cwd);
    let result = await gitService.readFileAtHead(filePath, DIFF_MEDIA_MAX_BYTES);
    if (!result.ok && result.reason === "NOT_FOUND") {
      // An already-committed deletion has no blob at literal HEAD — fall back
      // to the last commit whose tree still contained the path.
      result = await gitService.readPreviousFileVersion(filePath, DIFF_MEDIA_MAX_BYTES);
    }
    if (!result.ok) {
      return { ok: false, error: result.reason };
    }
    return toImageSide(mime, result.content);
  } catch (error) {
    console.error("[IPC] diff-media HEAD read failed:", error);
    return { ok: false, error: "ERROR" };
  }
}

// Same containment discipline as files:read — realpath containment against the
// canonicalized root, then an O_NOFOLLOW open of the caller-supplied path so a
// final-component symlink injected after the realpath check is rejected.
async function readWorkingSide(
  cwd: string,
  filePath: string,
  mime: string
): Promise<DiffMediaSide> {
  try {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(cwd);
    } catch (error) {
      console.error("[IPC] diff-media cwd resolution failed:", error);
      return { ok: false, error: "ERROR" };
    }

    const absolutePath = path.resolve(cwd, filePath);
    let realFile: string;
    try {
      realFile = await fs.realpath(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: false, error: "NOT_FOUND" };
      }
      return { ok: false, error: "ERROR" };
    }

    const contained =
      realRoot === path.sep
        ? realFile.startsWith(path.sep)
        : realFile === realRoot || realFile.startsWith(realRoot + path.sep);
    if (!contained) {
      return { ok: false, error: "ERROR" };
    }

    const stat = await fs.stat(realFile);
    // Only regular files: a FIFO in the worktree would wedge the read forever.
    if (!stat.isFile()) {
      return { ok: false, error: "ERROR" };
    }
    if (stat.size > DIFF_MEDIA_MAX_BYTES) {
      return { ok: false, error: "TOO_LARGE" };
    }

    // O_NONBLOCK (no-op on Windows) so a file swapped for a FIFO between the
    // stat and the open can't block the open itself; the fd stat below then
    // rejects anything that is no longer a regular in-budget file — the
    // pre-open checks only vetted a path, this vets what was actually opened.
    let fileHandle: Awaited<ReturnType<typeof fs.open>>;
    try {
      fileHandle = await fs.open(
        absolutePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: false, error: "NOT_FOUND" };
      }
      return { ok: false, error: "ERROR" };
    }

    let content: Buffer;
    try {
      const fdStat = await fileHandle.stat();
      if (!fdStat.isFile()) {
        return { ok: false, error: "ERROR" };
      }
      if (fdStat.size > DIFF_MEDIA_MAX_BYTES) {
        return { ok: false, error: "TOO_LARGE" };
      }
      content = await fileHandle.readFile();
    } finally {
      await fileHandle.close().catch(() => {});
    }

    if (content.byteLength > DIFF_MEDIA_MAX_BYTES) {
      return { ok: false, error: "TOO_LARGE" };
    }
    return toImageSide(mime, content);
  } catch (error) {
    console.error("[IPC] diff-media working-tree read failed:", error);
    return { ok: false, error: "ERROR" };
  }
}

async function handleReadFileVersions(
  payload: DiffMediaReadFileVersionsPayload
): Promise<DiffMediaFileVersions> {
  // Modest budget: each call can return up to ~21 MB of base64 (8 MB raw ×
  // ~1.33 × two sides), so the window is tighter than the text-diff channels.
  checkRateLimit(DIFF_MEDIA_METHOD_CHANNELS.readFileVersions, 10, 10_000);
  validatePayload(payload);

  const mime = getDiffMediaImageMime(payload.filePath);
  if (!mime) {
    return {
      head: { ok: false, error: "UNSUPPORTED" },
      working: { ok: false, error: "UNSUPPORTED" },
    };
  }

  const [head, working] = await Promise.all([
    readHeadSide(payload.cwd, payload.filePath, mime),
    readWorkingSide(payload.cwd, payload.filePath, mime),
  ]);
  return { head, working };
}

export const diffMediaNamespace = defineIpcNamespace({
  name: "diffMedia",
  ops: {
    readFileVersions: opValidated(
      DIFF_MEDIA_METHOD_CHANNELS.readFileVersions,
      DiffMediaReadFileVersionsPayloadSchema,
      handleReadFileVersions
    ),
  },
});

export function registerDiffMediaHandlers(): () => void {
  return diffMediaNamespace.register();
}
