import path from "path";
import fs from "fs/promises";
import { defineIpcNamespace, op } from "../define.js";
import { checkRateLimit } from "../utils.js";
import { DIFF_MEDIA_METHOD_CHANNELS } from "./diffMedia.preload.js";
import { gitServiceCache } from "../../services/GitServiceCache.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  DIFF_MEDIA_MAX_BYTES,
  type DiffMediaFileVersions,
  type DiffMediaReadFileVersionsPayload,
  type DiffMediaSide,
} from "../../../shared/types/ipc/diffMedia.js";

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

function getImageMime(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_MIME_BY_EXTENSION[filePath.slice(dot + 1).toLowerCase()] ?? null;
}

function toImageSide(mime: string, content: Buffer): DiffMediaSide {
  return {
    ok: true,
    dataUrl: `data:${mime};base64,${content.toString("base64")}`,
    byteSize: content.byteLength,
  };
}

function validatePayload(payload: DiffMediaReadFileVersionsPayload): void {
  const { cwd, filePath } = payload ?? {};
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "cwd must be an absolute path",
      context: { cwd },
    });
  }
  if (typeof filePath !== "string" || !filePath.trim()) {
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
    const result = await gitServiceCache
      .getGitService(cwd)
      .readFileAtHead(filePath, DIFF_MEDIA_MAX_BYTES);
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
    if (stat.size > DIFF_MEDIA_MAX_BYTES) {
      return { ok: false, error: "TOO_LARGE" };
    }

    let fileHandle: Awaited<ReturnType<typeof fs.open>>;
    try {
      fileHandle = await fs.open(absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ok: false, error: "NOT_FOUND" };
      }
      return { ok: false, error: "ERROR" };
    }

    let content: Buffer;
    try {
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
  checkRateLimit(DIFF_MEDIA_METHOD_CHANNELS.readFileVersions, 20, 10_000);
  validatePayload(payload);

  const mime = getImageMime(payload.filePath);
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
    readFileVersions: op(DIFF_MEDIA_METHOD_CHANNELS.readFileVersions, handleReadFileVersions),
  },
});

export function registerDiffMediaHandlers(): () => void {
  return diffMediaNamespace.register();
}
