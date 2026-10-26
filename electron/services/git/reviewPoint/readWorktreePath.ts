import { createHash } from "node:crypto";
import fs from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

/**
 * What one path holds in the working tree, read without git.
 *
 * A file's identity is the git blob id of its RAW bytes: no clean filter, no
 * line-ending conversion, nothing git would do on `add`. git's own "this file
 * matches the index" is a comparison after those transforms, so it can call
 * two different files equal; a content hash of the bytes on disk cannot. Being
 * content-addressed, an id found in git later names exactly these bytes, and
 * an id git never stored just doesn't resolve.
 */

export type ObjectFormat = "sha1" | "sha256";

export type WorktreeRead =
  | { kind: "absent" }
  | { kind: "file"; mode: "100644" | "100755"; oid: string; size: number }
  | { kind: "symlink"; oid: string }
  | { kind: "directory" }
  | { kind: "special" }
  | { kind: "too-large"; reason: "file-too-large" | "byte-limit" }
  | { kind: "unreadable"; code: string }
  | { kind: "changed" };

/** Enough of a stat to notice the path changing under the capture. */
export type StatSignature = string;

export interface ReadBudget {
  /** Bytes still allowed across the whole capture; each read reserves its size. */
  remainingBytes: number;
  maxFileBytes: number;
  signal?: AbortSignal;
}

const CHUNK_BYTES = 256 * 1024;

export function absoluteWorktreePath(root: string, relative: Buffer): string | Buffer {
  // POSIX paths are bytes, so a name that isn't valid UTF-8 is opened as the
  // exact bytes git listed. Windows paths are UTF-16 and git hands them over
  // as UTF-8, so they decode without loss.
  if (process.platform === "win32") return path.join(root, relative.toString("utf8"));
  return Buffer.concat([Buffer.from(root.endsWith("/") ? root : `${root}/`), relative]);
}

export function blobId(format: ObjectFormat, content: Buffer): string {
  return createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex");
}

export function statSignature(stats: BigIntStats | null): StatSignature {
  if (!stats) return "absent";
  return [stats.mode, stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
}

export async function lstatOrNull(target: string | Buffer): Promise<BigIntStats | null> {
  try {
    return await fs.promises.lstat(target, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR: a parent became a file, so this path cannot exist either.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

export interface WorktreeReadResult {
  read: WorktreeRead;
  /** The stat the read is valid for; compared again when the capture ends. */
  signature: StatSignature;
}

/**
 * @param fileModeTracked `core.fileMode`: when false git ignores the executable
 *   bit on disk and keeps whatever the index has, which is `indexMode`.
 */
export async function readWorktreePath(
  target: string | Buffer,
  format: ObjectFormat,
  budget: ReadBudget,
  fileModeTracked: boolean,
  indexMode: string | null
): Promise<WorktreeReadResult> {
  let before: BigIntStats | null;
  try {
    before = await lstatOrNull(target);
  } catch (error) {
    return unreadable(error);
  }
  const signature = statSignature(before);
  if (!before) return { read: { kind: "absent" }, signature };
  if (before.isDirectory()) return { read: { kind: "directory" }, signature };

  if (before.isSymbolicLink()) {
    try {
      const text = await fs.promises.readlink(target, { encoding: "buffer" });
      const after = await lstatOrNull(target);
      if (statSignature(after) !== signature) return { read: { kind: "changed" }, signature };
      return { read: { kind: "symlink", oid: blobId(format, text) }, signature };
    } catch (error) {
      return { read: unreadable(error).read, signature };
    }
  }

  if (!before.isFile()) return { read: { kind: "special" }, signature };

  const size = Number(before.size);
  if (size > budget.maxFileBytes) {
    return { read: { kind: "too-large", reason: "file-too-large" }, signature };
  }
  if (size > budget.remainingBytes) {
    return { read: { kind: "too-large", reason: "byte-limit" }, signature };
  }
  // Reserved in the same tick as the check, so reads running side by side
  // can't each spend the same remaining budget.
  budget.remainingBytes -= size;

  const executable = fileModeTracked ? (before.mode & 0o100n) !== 0n : indexMode === "100755";
  const mode = executable ? "100755" : "100644";

  // O_NOFOLLOW and O_NONBLOCK so a path swapped for a symlink or a FIFO after
  // the lstat can neither redirect the read nor block it forever.
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(target, flags);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || statSignature(opened) !== signature) {
      return { read: { kind: "changed" }, signature };
    }
    const hash = createHash(format).update(`blob ${size}\0`);
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(size, 1)));
    let total = 0;
    for (;;) {
      budget.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > size) return { read: { kind: "changed" }, signature };
      hash.update(chunk.subarray(0, bytesRead));
    }
    if (total !== size) return { read: { kind: "changed" }, signature };
    const after = await handle.stat({ bigint: true });
    if (statSignature(after) !== signature) return { read: { kind: "changed" }, signature };
    return { read: { kind: "file", mode, oid: hash.digest("hex"), size }, signature };
  } catch (error) {
    if (budget.signal?.aborted) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    // The path went away or turned into something else between lstat and open.
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") {
      return { read: { kind: "changed" }, signature };
    }
    return { read: unreadable(error).read, signature };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function unreadable(error: unknown): WorktreeReadResult {
  const code = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
  return { read: { kind: "unreadable", code }, signature: "unreadable" };
}
