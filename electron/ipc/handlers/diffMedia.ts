import path from "path";
import fs from "fs/promises";
import { defineIpcNamespace, opValidated } from "../define.js";
import { checkRateLimit } from "../utils.js";
import { DIFF_MEDIA_METHOD_CHANNELS } from "./diffMedia.preload.js";
import { isLfsPointer } from "./files.js";
import { DiffMediaReadFileVersionsPayloadSchema } from "../../schemas/ipc.js";
import { gitServiceCache } from "../../services/GitServiceCache.js";
import { AppError } from "../../utils/errorTypes.js";
import type { HeadFileReadOptions, HeadFileReadResult } from "../../services/GitService.js";
import {
  DIFF_MEDIA_MAX_BYTES,
  getDiffMediaImageMime,
  type DiffMediaFileVersionsResponse,
  type DiffMediaKnownVersions,
  type DiffMediaReadFileVersionsPayload,
  type DiffMediaWireSide,
} from "../../../shared/types/ipc/diffMedia.js";

// Modest budget: each call can return up to ~21 MB of base64 (8 MB raw ×
// ~1.33 × two sides), so the window is tighter than the text-diff channels.
const READ_MAX_CALLS = 10;
const READ_WINDOW_MS = 10_000;
// Revalidations that resend no bytes cost a stat and a rev-parse, so they get
// their own, looser budget; one that does need bytes also draws on the above.
const REVALIDATE_CHANNEL = `${DIFF_MEDIA_METHOD_CHANNELS.readFileVersions}:revalidate`;
const REVALIDATE_MAX_CALLS = 60;

function toImageSide(mime: string, content: Buffer, version?: string): DiffMediaWireSide {
  // Git LFS pointer files are text stand-ins for the real blob — served as
  // image bytes they just render broken.
  if (isLfsPointer(content)) {
    return { ok: false, error: "UNSUPPORTED" };
  }
  return {
    ok: true,
    dataUrl: `data:${mime};base64,${content.toString("base64")}`,
    byteSize: content.byteLength,
    ...(version !== undefined ? { version } : {}),
  };
}

function toBlobSide(mime: string, result: HeadFileReadResult): DiffMediaWireSide {
  if (!result.ok) {
    return { ok: false, error: result.reason };
  }
  if ("unchanged" in result) {
    return { ok: true, unchanged: true, version: result.version };
  }
  return toImageSide(mime, result.content, result.version);
}

// A file touched this recently may still be rewritten within the
// filesystem's timestamp granularity without its stat moving (git's "racy
// clean" problem), so it gets no version and is always reread.
const RACY_WINDOW_NS = 2_000_000_000n;

// Nanosecond stat fields that move on any rewrite; a same-size in-place edit
// still changes mtime/ctime, and a replace-by-rename changes the inode.
function workingVersion(stat: {
  dev?: unknown;
  ino?: unknown;
  size?: unknown;
  mtimeNs?: unknown;
  ctimeNs?: unknown;
}): string | undefined {
  const parts = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
  if (!parts.every((part): part is bigint => typeof part === "bigint")) {
    return undefined;
  }
  const [, , , mtimeNs, ctimeNs] = parts as bigint[];
  const newest = mtimeNs! > ctimeNs! ? mtimeNs! : ctimeNs!;
  if (BigInt(Date.now()) * 1_000_000n - newest < RACY_WINDOW_NS) {
    return undefined;
  }
  return `stat:${parts.join(":")}`;
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

async function readHeadSide(
  cwd: string,
  filePath: string,
  mime: string,
  options: HeadFileReadOptions
): Promise<DiffMediaWireSide> {
  try {
    const result = await gitServiceCache
      .getGitService(cwd)
      .readFileAtHead(filePath, DIFF_MEDIA_MAX_BYTES, options);
    return toBlobSide(mime, result);
  } catch (error) {
    if (isRateLimited(error)) throw error;
    console.error("[IPC] diff-media HEAD read failed:", error);
    return { ok: false, error: "ERROR" };
  }
}

async function readPreviousSide(
  cwd: string,
  filePath: string,
  mime: string,
  options: HeadFileReadOptions
): Promise<DiffMediaWireSide> {
  try {
    const result = await gitServiceCache
      .getGitService(cwd)
      .readPreviousFileVersion(filePath, DIFF_MEDIA_MAX_BYTES, options);
    return toBlobSide(mime, result);
  } catch (error) {
    if (isRateLimited(error)) throw error;
    console.error("[IPC] diff-media prior-version read failed:", error);
    return { ok: false, error: "ERROR" };
  }
}

function isRateLimited(error: unknown): boolean {
  return error instanceof AppError && error.code === "RATE_LIMITED";
}

function isMissing(side: DiffMediaWireSide): boolean {
  return !side.ok && side.error === "NOT_FOUND";
}

// Same containment discipline as files:read — realpath containment against the
// canonicalized root, then an O_NOFOLLOW open of the caller-supplied path so a
// final-component symlink injected after the realpath check is rejected.
async function readWorkingSide(
  cwd: string,
  filePath: string,
  mime: string,
  options: HeadFileReadOptions
): Promise<DiffMediaWireSide> {
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
    let version: string | undefined;
    try {
      const fdStat = await fileHandle.stat({ bigint: true });
      if (!fdStat.isFile()) {
        return { ok: false, error: "ERROR" };
      }
      if (fdStat.size > DIFF_MEDIA_MAX_BYTES) {
        return { ok: false, error: "TOO_LARGE" };
      }
      // Taken from the opened fd before the read, so a write racing the read
      // leaves content newer than its version — a later revalidation misses.
      version = workingVersion(fdStat);
      if (version !== undefined && version === options.knownVersion) {
        return { ok: true, unchanged: true, version };
      }
      options.beforeRead?.();
      content = await fileHandle.readFile();
    } finally {
      await fileHandle.close().catch(() => {});
    }

    if (content.byteLength > DIFF_MEDIA_MAX_BYTES) {
      return { ok: false, error: "TOO_LARGE" };
    }
    return toImageSide(mime, content, version);
  } catch (error) {
    if (isRateLimited(error)) throw error;
    console.error("[IPC] diff-media working-tree read failed:", error);
    return { ok: false, error: "ERROR" };
  }
}

function hasKnownVersions(known: DiffMediaKnownVersions | undefined): boolean {
  return known?.head !== undefined || known?.working !== undefined;
}

async function handleReadFileVersions(
  payload: DiffMediaReadFileVersionsPayload
): Promise<DiffMediaFileVersionsResponse> {
  const known = hasKnownVersions(payload.known) ? payload.known : undefined;
  let beforeRead: (() => void) | undefined;
  if (known) {
    // A revalidation only draws on the byte budget if some side actually has
    // to be read and resent.
    checkRateLimit(REVALIDATE_CHANNEL, REVALIDATE_MAX_CALLS, READ_WINDOW_MS);
    // Settled once: a denial is remembered so the sibling side can't read
    // bytes for a request that is already rejected.
    let charge: { ok: true } | { ok: false; error: unknown } | undefined;
    beforeRead = () => {
      if (!charge) {
        try {
          checkRateLimit(
            DIFF_MEDIA_METHOD_CHANNELS.readFileVersions,
            READ_MAX_CALLS,
            READ_WINDOW_MS
          );
          charge = { ok: true };
        } catch (error) {
          charge = { ok: false, error };
        }
      }
      if (!charge.ok) throw charge.error;
    };
  } else {
    checkRateLimit(DIFF_MEDIA_METHOD_CHANNELS.readFileVersions, READ_MAX_CALLS, READ_WINDOW_MS);
  }
  validatePayload(payload);

  const mime = getDiffMediaImageMime(payload.filePath);
  if (!mime) {
    return {
      head: { ok: false, error: "UNSUPPORTED" },
      working: { ok: false, error: "UNSUPPORTED" },
    };
  }

  const [headAtHead, working] = await Promise.all([
    readHeadSide(payload.cwd, payload.filePath, mime, { knownVersion: known?.head, beforeRead }),
    readWorkingSide(payload.cwd, payload.filePath, mime, {
      knownVersion: known?.working,
      beforeRead,
    }),
  ]);

  // Both sides missing is the signature of an already-committed deletion —
  // literal HEAD has moved past the delete, so show the last committed
  // version. Gated on the working side too: for a never-tracked path (a
  // working copy exists) rev-list would scan the full history just to
  // return nothing.
  const head =
    isMissing(headAtHead) && isMissing(working)
      ? await readPreviousSide(payload.cwd, payload.filePath, mime, {
          knownVersion: known?.head,
          beforeRead,
        })
      : headAtHead;

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
