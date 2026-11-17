import { constants as fsConstants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { DeclaredProjectLink } from "../../shared/types/projectLinks.js";
import { declaredLinksFromPackageJson } from "../../shared/utils/declaredProjectLinks.js";
import { readBoundedFromHandle } from "../utils/boundedRead.js";
import { stripUtf8Bom } from "../utils/stripUtf8Bom.js";
import { projectIo } from "./projectIoGate.js";

// A manifest bigger than this is generated output, not something a person wrote.
const MAX_MANIFEST_BYTES = 512 * 1024;

/**
 * Errors that settle what the project declares: the file or a folder above it
 * isn't there, isn't a file, or can't be read by this user. Anything else
 * (`EIO`, `ESTALE`, `EMFILE`, the I/O gate giving up) may clear on the next
 * read, so it rejects and the caller keeps the list it has.
 */
const SETTLED_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ELOOP",
  "EACCES",
  "EPERM",
  "ENXIO",
  "ENAMETOOLONG",
]);

const decoder = new TextDecoder("utf-8");

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

/**
 * Close without waiting: `FileHandle.close()` waits for the handle's pending
 * operations, so awaiting it after the gate gave up on a stalled read would
 * hold the caller as long as the kernel holds the read.
 */
function closeLater(handle: Promise<FileHandle> | FileHandle): void {
  void Promise.resolve(handle).then(
    (opened) => opened.close().catch(() => undefined),
    () => undefined
  );
}

/**
 * The links the package.json at the project's root declares (#17252). Read
 * from disk on every call and never written: a missing, unreadable, oversized
 * or malformed file declares nothing. A manifest linked from outside the root
 * is refused, anything but a regular file declares nothing, and the open is
 * non-blocking so a FIFO swapped in after the check can't hold it. A failure
 * that may pass (a stalled or busy disk, a full descriptor table) rejects
 * instead, so the caller keeps what it last showed and asks again later
 * rather than emptying the list.
 */
export async function readDeclaredProjectLinks(
  projectRoot: string
): Promise<DeclaredProjectLink[]> {
  const io = <T>(request: () => Promise<T>): Promise<T> => projectIo.run(projectRoot, request);
  try {
    const realRoot = await io(() => realpath(projectRoot));
    const manifestPath = await io(() => realpath(join(realRoot, "package.json")));
    if (!isWithin(realRoot, manifestPath)) return [];
    // Settles a socket, FIFO or folder at the path before an open that some
    // of them refuse with errors that say nothing about what stands there.
    if (!(await io(() => stat(manifestPath))).isFile()) return [];
    let opening: Promise<FileHandle> | undefined;
    let handle: FileHandle;
    try {
      handle = await io(
        () =>
          (opening = open(
            manifestPath,
            fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
          ))
      );
    } catch (error) {
      // An open the gate stopped waiting for still lands; its descriptor is ours to close.
      if (opening !== undefined) closeLater(opening);
      throw error;
    }
    try {
      const info = await io(() => handle.stat());
      if (!info.isFile()) return [];
      // One worker at a time: the bounded read's calls run one after another.
      const bytes = await io(() => readBoundedFromHandle(handle, info.size, MAX_MANIFEST_BYTES));
      if (bytes === null) return [];
      return declaredLinksFromPackageJson(JSON.parse(stripUtf8Bom(decoder.decode(bytes))));
    } finally {
      closeLater(handle);
    }
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    const code = errorCode(error);
    if (code !== undefined && SETTLED_CODES.has(code)) return [];
    throw error;
  }
}
