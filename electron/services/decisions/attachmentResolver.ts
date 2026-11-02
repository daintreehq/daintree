import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  BridgeError,
  type AttachmentResolver,
  type QuestionOrigin,
} from "@daintreehq/decisions-client";
import { sniffImageMime } from "@daintreehq/decisions-crypto";
import { LIMITS } from "@daintreehq/decisions-protocol";

/** Past any path a platform opens; the library's own schema stops far shorter. */
const MAX_ID_CHARS = 1024;
/** How much of an agent's id a refusal repeats back to it. */
const ECHO_CHARS = 200;
const READ_CHUNK_BYTES = 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Doesn't block on a FIFO swapped in after the checks, and doesn't follow a
 * symlink swapped in for the file itself. Neither flag exists on Windows.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function refuse(id: string, problem: string): BridgeError {
  const shown = id.length > ECHO_CHARS ? `${id.slice(0, ECHO_CHARS)}…` : id;
  return new BridgeError("attachment_error", `attachment ${JSON.stringify(shown)} ${problem}`);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * What is wrong with `id` as a path relative to a worktree, before anything
 * is read; null when nothing is. On Windows that also refuses a drive-relative
 * path (`C:shot.png`, which names that drive's own current directory) and an
 * alternate data stream (`shot.png:hidden`).
 */
export function relativeIdProblem(
  id: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (id.length > MAX_ID_CHARS) return "is too long to be a path";
  if (id.includes("\0")) return "isn't a valid path";
  const windows = platform === "win32";
  const absolute = windows ? path.win32.isAbsolute(id) : path.posix.isAbsolute(id);
  if (absolute || (windows && id.includes(":"))) {
    return "must be a path relative to this terminal's worktree";
  }
  return null;
}

/**
 * Whether `target` is strictly inside `root`, both real paths. Windows'
 * `path.relative` ignores case, but a directory there can be case-sensitive,
 * with `repo` and `REPO` side by side; real paths carry each directory's own
 * spelling, so the root must also be the target's exact leading components.
 */
export function isInsideRoot(
  root: string,
  target: string,
  paths: path.PlatformPath = path
): boolean {
  const relative = paths.relative(root, target);
  if (relative === "" || paths.isAbsolute(relative)) return false;
  if (relative === ".." || relative.startsWith(`..${paths.sep}`)) return false;
  const prefix = root.endsWith(paths.sep) ? root : `${root}${paths.sep}`;
  return target.startsWith(prefix);
}

/** Whether `mime`, as the library sniffed it, holds for the whole signature. */
function hasFullSignature(bytes: Uint8Array, mime: string): boolean {
  if (mime !== "image/png") return true;
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

async function realRootOf(origin: QuestionOrigin, id: string): Promise<string> {
  const root = origin.worktree_root;
  if (!root || !path.isAbsolute(root)) {
    throw refuse(id, "can't be read: this terminal has no launch worktree to attach files from");
  }
  try {
    const real = await realpath(root);
    if ((await stat(real)).isDirectory()) return real;
  } catch {
    // Refused below.
  }
  throw refuse(id, "can't be read: this terminal's worktree can't be opened");
}

async function realTargetOf(root: string, id: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path.resolve(root, id));
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw refuse(id, "isn't a file in this terminal's worktree");
    }
    throw refuse(id, "can't be read");
  }
  if (real === root) throw refuse(id, "isn't a regular file");
  if (!isInsideRoot(root, real)) {
    throw refuse(id, "is outside this terminal's worktree, so it can't be attached");
  }
  return real;
}

function sizeProblem(size: bigint): string | null {
  if (size === 0n) return "is empty";
  if (size > BigInt(LIMITS.attachmentBytes)) return "is larger than 20 MiB";
  return null;
}

/**
 * Exactly `size` bytes, or null when the file turned out longer or shorter
 * (it was written to after its size was read). Reads one byte past `size` at
 * most, so a file that grows can't make it read without bound.
 */
async function readExactly(handle: FileHandle, size: number): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(size + 1);
  let total = 0;
  while (total < bytes.length) {
    const length = Math.min(READ_CHUNK_BYTES, bytes.length - total);
    const { bytesRead } = await handle.read(bytes, total, length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total === size ? bytes.subarray(0, size) : null;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * The image at `real`, a path already checked to be inside the worktree. The
 * file is identified before it is opened, and what was opened must be that
 * same file, still named by the same real path afterwards. That shuts out a
 * file or directory swapped for a symlink between the checks and the open,
 * though not an adversary who keeps swapping a directory back and forth:
 * path checks can only narrow that race, never close it.
 */
async function readImage(real: string, id: string): Promise<Uint8Array> {
  let before: BigIntStats;
  try {
    before = await lstat(real, { bigint: true });
  } catch {
    throw refuse(id, "can't be read");
  }
  if (!before.isFile()) throw refuse(id, "isn't a regular file");
  const early = sizeProblem(before.size);
  if (early !== null) throw refuse(id, early);

  let handle: FileHandle;
  try {
    handle = await open(real, OPEN_FLAGS);
  } catch {
    throw refuse(id, "can't be read");
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw refuse(id, "changed while it was being read");
    }
    const again = await realpath(real).catch(() => null);
    const named = again === real ? await stat(real, { bigint: true }).catch(() => null) : null;
    if (named === null || !sameFile(named, opened)) {
      throw refuse(id, "changed while it was being read");
    }
    const problem = sizeProblem(opened.size);
    if (problem !== null) throw refuse(id, problem);
    const bytes = await readExactly(handle, Number(opened.size)).catch(() => {
      throw refuse(id, "can't be read");
    });
    if (bytes === null) throw refuse(id, "changed while it was being read");
    const mime = sniffImageMime(bytes);
    if (mime === null || !hasFullSignature(bytes, mime)) {
      throw refuse(
        id,
        "isn't a PNG, JPEG or WebP image (its content is checked, not its name; SVG is refused)"
      );
    }
    return bytes;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Where the images an agent attaches to a question come from (#16014). An
 * attachment's `local_resource_id` is the agent's, so untrusted: it is a path
 * relative to the pane's launch worktree, the directory its record says it
 * was started in (never anything the agent sends), and the real path of the
 * file, after every symlink, must be inside that directory's real path. Only
 * a regular file of at most 20 MiB whose bytes start like a PNG, JPEG or WebP
 * image is read. The library checks size, total and type again before it
 * encrypts and spools the bytes.
 *
 * A refusal is an `attachment_error` naming the agent's own id and what was
 * wrong with it; nothing read from the file is ever in it.
 */
export function createWorktreeAttachmentResolver(): AttachmentResolver {
  return {
    async resolve(origin, localResourceId) {
      const id = localResourceId;
      if (typeof id !== "string" || id.length === 0) {
        throw new BridgeError("attachment_error", "an attachment's local_resource_id is empty");
      }
      const problem = relativeIdProblem(id);
      if (problem !== null) throw refuse(id, problem);
      const root = await realRootOf(origin, id);
      const real = await realTargetOf(root, id);
      return { bytes: await readImage(real, id) };
    },
  };
}
