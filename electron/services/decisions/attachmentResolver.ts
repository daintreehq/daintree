import { constants } from "node:fs";
import { realpath, stat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  BridgeError,
  type AttachmentResolver,
  type QuestionOrigin,
} from "@daintreehq/decisions-client";
import { sniffImageMime } from "@daintreehq/decisions-crypto";
import { LIMITS } from "@daintreehq/decisions-protocol";

/** Longer than any path a platform opens, so nothing real is refused by it. */
const MAX_ID_CHARS = 4096;
/** How much of an agent's id a refusal repeats back to it. */
const ECHO_CHARS = 200;
const READ_CHUNK_BYTES = 1024 * 1024;

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

/** Whether `target` is strictly inside `root`; both already real paths. */
export function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === "" || path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function realRootOf(origin: QuestionOrigin, id: string): Promise<string> {
  const root = origin.worktree_root;
  if (!root || !path.isAbsolute(root)) {
    throw refuse(id, "can't be read: this terminal has no launch worktree to attach files from");
  }
  try {
    return await realpath(root);
  } catch {
    throw refuse(id, "can't be read: this terminal's worktree can't be opened");
  }
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

async function readImage(real: string, id: string): Promise<Uint8Array> {
  let handle: FileHandle;
  try {
    handle = await open(real, OPEN_FLAGS);
  } catch {
    throw refuse(id, "can't be read");
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw refuse(id, "isn't a regular file");
    // Whatever was opened must still be what the checked path names, so a
    // directory swapped for a symlink between the checks and the open can't
    // smuggle in a file from elsewhere.
    let again: string;
    try {
      again = await realpath(real);
    } catch {
      throw refuse(id, "changed while it was being read");
    }
    const named = await stat(again, { bigint: true }).catch(() => null);
    if (again !== real || named === null || named.dev !== opened.dev || named.ino !== opened.ino) {
      throw refuse(id, "changed while it was being read");
    }
    const size = Number(opened.size);
    if (size === 0) throw refuse(id, "is empty");
    if (size > LIMITS.attachmentBytes) throw refuse(id, "is larger than 20 MiB");
    const bytes = await readExactly(handle, size).catch(() => {
      throw refuse(id, "can't be read");
    });
    if (bytes === null) throw refuse(id, "changed while it was being read");
    if (sniffImageMime(bytes) === null) {
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
 * resolved against the pane's launch worktree, the directory its record says
 * it was started in (never anything the agent sends), and the real path of
 * the file, after every symlink, must be inside that worktree's real path.
 * Only a regular file of at most 20 MiB whose bytes are a PNG, JPEG or WebP
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
      if (id.length > MAX_ID_CHARS) throw refuse(id, "is too long to be a path");
      if (id.includes("\0")) throw refuse(id, "isn't a valid path");
      const root = await realRootOf(origin, id);
      const real = await realTargetOf(root, id);
      return { bytes: await readImage(real, id) };
    },
  };
}
