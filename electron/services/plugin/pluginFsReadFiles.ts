import type { FileHandle } from "fs/promises";
import { PLUGIN_INVOKE_MAX_RESULT_BYTES } from "../../../shared/config/pluginBudgets.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type {
  PluginFsReadFilesEncoding,
  PluginFsReadFilesEntry,
  PluginFsReadFilesErrorCode,
} from "../../../shared/types/plugin.js";

/** Most paths one `fs.readFiles` call accepts. */
export const PLUGIN_FS_READ_FILES_MAX_PATHS = 1024;

/**
 * Content budget for one `fs.readFiles` call. Half the invoke result cap, so
 * the reply still fits when it is relayed onward and re-encoded (UTF-16 on
 * a structured clone, JSON escaping on an invoke result).
 */
export const PLUGIN_FS_READ_FILES_MAX_TOTAL_BYTES = PLUGIN_INVOKE_MAX_RESULT_BYTES / 2;

/** Reads in flight at once: enough to hide per-file latency without a burst of descriptors. */
const READ_FILES_CONCURRENCY = 8;

export interface ValidatedReadFilesCall {
  paths: string[];
  encoding: PluginFsReadFilesEncoding;
  maxBytesPerFile: number | undefined;
  signal: AbortSignal | undefined;
}

export function validateReadFilesCall(
  pluginId: string,
  paths: unknown,
  options: unknown
): ValidatedReadFilesCall {
  const fail = (why: string): never => {
    throw new Error(`VALIDATION: plugin "${pluginId}" fs.readFiles: ${why}`);
  };
  if (!Array.isArray(paths)) fail("paths must be an array of strings");
  const list = paths as unknown[];
  if (list.length > PLUGIN_FS_READ_FILES_MAX_PATHS) {
    fail(`at most ${PLUGIN_FS_READ_FILES_MAX_PATHS} paths per call (got ${list.length})`);
  }
  if (list.some((p) => typeof p !== "string" || p.length === 0)) {
    fail("every path must be a non-empty string");
  }
  if (options !== undefined && (options === null || typeof options !== "object")) {
    fail("options must be an object");
  }
  const opts = (options ?? {}) as {
    encoding?: unknown;
    maxBytesPerFile?: unknown;
    signal?: AbortSignal;
  };
  const encoding = opts.encoding ?? "utf-8";
  if (encoding !== "utf-8" && encoding !== "bytes") {
    fail('encoding must be "utf-8" or "bytes"');
  }
  const max = opts.maxBytesPerFile;
  if (max !== undefined && (typeof max !== "number" || !Number.isSafeInteger(max) || max < 0)) {
    fail("maxBytesPerFile must be a non-negative integer");
  }
  return {
    paths: list as string[],
    encoding: encoding as PluginFsReadFilesEncoding,
    maxBytesPerFile: max as number | undefined,
    signal: opts.signal,
  };
}

/**
 * Read at most `limit + 1` bytes from `handle`, sized from the opened file's
 * length so a small file never allocates the whole budget. Resolves `null`
 * when the file holds more than `limit` bytes — the extra byte is how that is
 * recognised without reading further.
 */
export async function readBoundedFromHandle(
  handle: FileHandle,
  sizeHint: number,
  limit: number,
  signal: AbortSignal | undefined
): Promise<Buffer | null> {
  if (sizeHint > limit) return null;
  let buffer = Buffer.allocUnsafe(Math.min(limit, Math.max(0, sizeHint)) + 1);
  let filled = 0;
  for (;;) {
    signal?.throwIfAborted();
    if (filled === buffer.length) {
      // The file grew after it was opened; keep going up to the ceiling.
      if (buffer.length > limit) break;
      const grown = Buffer.allocUnsafe(Math.min(limit + 1, buffer.length * 2));
      buffer.copy(grown, 0, 0, filled);
      buffer = grown;
    }
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  if (filled > limit) return null;
  return buffer.subarray(0, filled);
}

/** What reading one contained path produced. */
export type ReadOneOutcome =
  { status: "ok"; bytes: Buffer } | { status: "too-large" } | { status: "not-a-file" };

const PASSTHROUGH_CODES = new Set<PluginFsReadFilesErrorCode>([
  "TARGET_IS_SYMLINK",
  "TARGET_UNAVAILABLE",
]);

/** Map a per-path failure to its entry code, or rethrow what must fail the whole call. */
export function readFilesErrorCode(
  error: unknown,
  signal: AbortSignal | undefined
): PluginFsReadFilesErrorCode {
  if (signal?.aborted) throw error;
  const message = formatErrorMessage(error, "");
  if (message.startsWith("PLUGIN_UNLOADED")) throw error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && PASSTHROUGH_CODES.has(code as PluginFsReadFilesErrorCode)) {
    return code as PluginFsReadFilesErrorCode;
  }
  if (message.startsWith("PATH_NOT_ALLOWED")) return "PATH_NOT_ALLOWED";
  if (message.startsWith("PERMISSION_REQUIRED")) return "PERMISSION_REQUIRED";
  if (code === "ENOENT" || code === "ENOTDIR") return "NOT_FOUND";
  if (code === "EISDIR") return "NOT_A_FILE";
  return "READ_FAILED";
}

/**
 * Run a validated `readFiles` call. `readOne` does everything `readFile` does
 * for one path — containment, the root's capability, the verified open — and
 * reads no more than `limit` bytes. Results come back in request order.
 *
 * Reads overlap, but the budget is spent strictly in request order: a read
 * starts only within a fixed window past the last committed entry, capped by
 * what is left after the committed ones, so which entries are deferred never
 * depends on which read happened to finish first, and at most the window's
 * worth of uncommitted bytes is held at once.
 */
export async function runReadFiles(
  call: ValidatedReadFilesCall,
  readOne: (filePath: string, limit: number) => Promise<ReadOneOutcome>
): Promise<PluginFsReadFilesEntry<string | Uint8Array>[]> {
  const { paths, encoding, maxBytesPerFile, signal } = call;
  signal?.throwIfAborted();
  const results = new Array<PluginFsReadFilesEntry<string | Uint8Array>>(paths.length);
  let remaining = PLUGIN_FS_READ_FILES_MAX_TOTAL_BYTES;
  const failure = (
    filePath: string,
    code: PluginFsReadFilesErrorCode,
    message: string
  ): PluginFsReadFilesEntry<never> => ({ path: filePath, ok: false, error: { code, message } });

  type Pending =
    | { kind: "done"; outcome: ReadOneOutcome; perFileBinds: boolean }
    | { kind: "failed"; error: unknown; perFileBinds: boolean };
  // Never rejects: a failure is carried to its turn in the commit loop, so a
  // read that fails while an earlier one is awaited is not an unhandled rejection.
  const start = (index: number): Promise<Pending> => {
    const perFileBinds = maxBytesPerFile !== undefined && maxBytesPerFile <= remaining;
    const limit = perFileBinds ? maxBytesPerFile! : remaining;
    return readOne(paths[index]!, limit).then(
      (outcome): Pending => ({ kind: "done", outcome, perFileBinds }),
      (error: unknown): Pending => ({ kind: "failed", error, perFileBinds })
    );
  };

  const inFlight: Array<Promise<Pending> | undefined> = [];
  let nextStart = 0;
  const fill = (committed: number): void => {
    while (nextStart < paths.length && nextStart < committed + READ_FILES_CONCURRENCY) {
      inFlight[nextStart] = start(nextStart);
      nextStart++;
    }
  };
  fill(0);
  for (let index = 0; index < paths.length; index++) {
    const pending = await inFlight[index]!;
    inFlight[index] = undefined;
    signal?.throwIfAborted();
    const filePath = paths[index]!;
    const budgetSpent = failure(
      filePath,
      "RESULT_TOO_LARGE",
      "the call's content budget is spent; read this path in another call"
    );
    if (pending.kind === "failed") {
      const code = readFilesErrorCode(pending.error, signal);
      results[index] = failure(filePath, code, formatErrorMessage(pending.error, "read failed"));
    } else if (pending.outcome.status === "not-a-file") {
      results[index] = failure(filePath, "NOT_A_FILE", "not a regular file");
    } else if (pending.outcome.status === "too-large") {
      results[index] = pending.perFileBinds
        ? failure(filePath, "TOO_LARGE", `larger than maxBytesPerFile (${maxBytesPerFile})`)
        : budgetSpent;
    } else {
      // Charged at what the reply carries: decoded text can be longer than
      // the bytes it came from (each invalid byte becomes a 3-byte U+FFFD).
      const content =
        encoding === "bytes"
          ? // Copied out of Node's pooled allocator, which holds unrelated reads.
            new Uint8Array(pending.outcome.bytes)
          : pending.outcome.bytes.toString("utf-8");
      const cost =
        typeof content === "string" ? Buffer.byteLength(content, "utf-8") : content.byteLength;
      if (cost > remaining) {
        results[index] = budgetSpent;
      } else {
        remaining -= cost;
        results[index] = { path: filePath, ok: true, content };
      }
    }
    fill(index + 1);
  }
  signal?.throwIfAborted();
  return results;
}
