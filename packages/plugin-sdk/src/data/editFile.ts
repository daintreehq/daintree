import type { PluginFsApi } from "../../../../shared/types/plugin.js";
import { contentRevision } from "./revision.js";

/**
 * The slice of the host `editFile` needs. `PluginHostApi` satisfies it, and so
 * does any object whose `fs` carries these two methods.
 */
export interface EditFileHost {
  readonly fs: Pick<PluginFsApi, "readFileBytes" | "writeFile">;
}

/**
 * Receives the file's current text, or `null` when it does not exist. Return
 * the new text to write it, or the same text, `null` or `undefined` to leave
 * the file as it is. It may run more than once — once per attempt — so it
 * should compute from its argument rather than from state it mutates.
 */
export type EditFileTransform = (
  current: string | null
) => string | null | undefined | Promise<string | null | undefined>;

export interface EditFileOptions {
  /**
   * How many times to re-read and re-apply after another writer changed the
   * file between this read and this write. Default 5. When they run out, the
   * last conflict error is thrown.
   */
  retries?: number;
}

export interface EditFileResult {
  /** Whether this call wrote the file. */
  written: boolean;
  /**
   * The file's revision afterwards: of the bytes written, or of the bytes
   * read when nothing was written. `null` when the file does not exist.
   */
  revision: string | null;
}

const DEFAULT_RETRIES = 5;

// Retried because each means "the file is not what we read": a write against a
// stale revision, a create that lost a race, or a file that vanished or was
// swapped mid-operation. The host documents the last as safe to retry.
const CONFLICT_CODES = new Set(["REVISION_MISMATCH", "TARGET_EXISTS", "TARGET_UNAVAILABLE"]);

/**
 * The host's error code. In-process callers get it on `code`; an error that
 * crossed the plugin worker port keeps only its message, which starts with the
 * same token.
 */
function hostErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string") return code;
  if (typeof message !== "string") return null;
  return /^([A-Z][A-Z_]+):/.exec(message)?.[1] ?? null;
}

function decodeUtf8(bytes: Uint8Array, filePath: string): string {
  try {
    // `ignoreBOM` keeps a byte order mark in the text, so writing the text
    // back reproduces it rather than silently dropping it.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`editFile: "${filePath}" is not valid UTF-8 text, so it cannot be edited`);
  }
}

/**
 * Read a file, transform its text, and write the result back only if nobody
 * else changed it in between — re-reading and re-applying `transform` when
 * someone did. This is the read → modify → `writeFile({ expectedRevision })`
 * loop every plugin that edits a shared file needs, so an agent's edit to the
 * same file is never clobbered.
 *
 * The file is read as bytes and its revision is the hash of those bytes, so the
 * check is exact even for a file with a byte order mark. A file that is not
 * valid UTF-8 is refused rather than corrupted. A missing file is passed to
 * `transform` as `null`; returning text creates it (a create-new write that
 * fails if the file appears first, which is retried like any other conflict).
 * The parent directory must already exist.
 */
export async function editFile(
  host: EditFileHost,
  filePath: string,
  transform: EditFileTransform,
  options: EditFileOptions = {}
): Promise<EditFileResult> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new TypeError("editFile: retries must be a non-negative integer");
  }

  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retries;
    let bytes: Uint8Array | null;
    try {
      bytes = await host.fs.readFileBytes(filePath);
    } catch (error) {
      const code = hostErrorCode(error);
      if (code === "ENOENT") {
        bytes = null;
      } else if (code === "TARGET_UNAVAILABLE" && canRetry) {
        continue;
      } else {
        throw error;
      }
    }

    const current = bytes === null ? null : decodeUtf8(bytes, filePath);
    const revision = bytes === null ? null : await contentRevision(bytes);
    const next = await transform(current);
    if (next === null || next === undefined || next === current) {
      return { written: false, revision };
    }
    if (typeof next !== "string") {
      throw new TypeError("editFile: transform must return a string, null or undefined");
    }

    try {
      const result = await host.fs.writeFile(filePath, next, { expectedRevision: revision });
      return { written: true, revision: result.revision };
    } catch (error) {
      const code = hostErrorCode(error);
      if (canRetry && code !== null && CONFLICT_CODES.has(code)) continue;
      throw error;
    }
  }
}
