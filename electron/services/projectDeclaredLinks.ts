import { constants as fsConstants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { DeclaredProjectLink } from "../../shared/types/projectLinks.js";
import { declaredLinksFromPackageJson } from "../../shared/utils/declaredProjectLinks.js";
import { readBoundedFromHandle } from "../utils/boundedRead.js";
import { stripUtf8Bom } from "../utils/stripUtf8Bom.js";
import { isProjectIoError, projectIo } from "./projectIoGate.js";

// A manifest bigger than this is generated output, not something a person wrote.
const MAX_MANIFEST_BYTES = 512 * 1024;

const decoder = new TextDecoder("utf-8");

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The links the package.json at the project's root declares (#17252). Read
 * from disk on every call and never written: a missing, unreadable, oversized
 * or malformed file declares nothing. A manifest linked from outside the root
 * is refused, and the open is non-blocking so a FIFO standing at the path
 * can't hold it. Only a read the project I/O gate gave up on rejects, so the
 * caller keeps what it last showed and asks again later instead of emptying
 * the list for a slow disk.
 */
export async function readDeclaredProjectLinks(
  projectRoot: string
): Promise<DeclaredProjectLink[]> {
  const io = <T>(request: () => Promise<T>): Promise<T> => projectIo.run(projectRoot, request);
  try {
    const realRoot = await io(() => realpath(projectRoot));
    const manifestPath = await io(() => realpath(join(realRoot, "package.json")));
    if (!isWithin(realRoot, manifestPath)) return [];
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
      void opening?.then(
        (late) => late.close().catch(() => undefined),
        () => undefined
      );
      throw error;
    }
    try {
      const info = await io(() => handle.stat());
      if (!info.isFile()) return [];
      const bytes = await io(() => readBoundedFromHandle(handle, info.size, MAX_MANIFEST_BYTES));
      if (bytes === null) return [];
      return declaredLinksFromPackageJson(JSON.parse(stripUtf8Bom(decoder.decode(bytes))));
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    if (isProjectIoError(error)) throw error;
    return [];
  }
}
