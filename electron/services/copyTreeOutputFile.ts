import crypto from "crypto";
import os from "os";
import path from "path";
import { chmod, mkdir, open, readdir, rm, stat } from "fs/promises";
import { logWarn } from "../utils/logger.js";

/**
 * Temp-file plumbing for file-backed CopyTree generation (#11528).
 *
 * `copyTree.generate` used to hand its whole bundle back as a string — 31 MB on
 * this repo — which crossed three structured-clone boundaries before the MCP
 * transport cap trimmed it to 50 KiB. It now writes the bundle to a file here
 * and returns the path, so the only thing that travels is a few hundred bytes
 * of metadata.
 *
 * That makes retention this module's problem. The tool sits on the lowest MCP
 * tier and is rate-limited to 5 calls per 10s, so an unattended agent can write
 * a lot of context in a short time, and nothing else ever cleans this directory
 * up.
 */

/**
 * Shared temp directory for every generated bundle.
 *
 * Resolved per call rather than captured at import: `os.tmpdir()` reads the
 * environment every time, and pinning it at module load would freeze whatever
 * `TMPDIR` happened to be when this module was first touched.
 */
export function contextDir(): string {
  return path.join(os.tmpdir(), "daintree-context");
}

/**
 * Ceiling on a single bundle.
 *
 * Pruning is retrospective: it cannot stop one in-flight run from filling the
 * disk, so the streamed writer stops itself. Well clear of the ~31 MB a large
 * real repository produces, low enough that a runaway run fails instead of
 * consuming everything.
 */
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * Retention. Bundles are consumed immediately (an agent reads the path it was
 * just handed, or the user pastes the one on their clipboard), so keeping the
 * newest few is enough.
 *
 * Deliberately no aggregate-byte quota: `generateAndCopyFile` puts a path on
 * the user's clipboard to paste elsewhere, and a size-pressure sweep could
 * delete that file seconds after they copied it. The count and per-file
 * ceilings bound the directory without that hazard.
 */
export const MAX_RETAINED_FILES = 10;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Partials only outlive their run when the process died mid-write. */
const MAX_PARTIAL_AGE_MS = 60 * 60 * 1000;

const PARTIAL_SUFFIX = ".part";

/**
 * Paths handed out but not yet finished. Pruning runs while other generations
 * are in flight, and deleting the file one of them is about to publish (or is
 * writing right now) would fail that run for no reason.
 */
const reservedPaths = new Set<string>();

function sanitizeSegment(value: string, maxLength: number): string {
  return value
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

/**
 * Build the bundle's filename.
 *
 * The UUID is load-bearing, not decorative: two generations of the same
 * worktree started inside the same millisecond would otherwise collide on the
 * timestamp and one would overwrite the other's output.
 */
export function buildContextFileName(options: {
  projectName: string;
  branch: string;
  extension: string;
  timestamp: string;
}): string {
  const project = sanitizeSegment(options.projectName, 50) || "project";
  const branch = sanitizeSegment(options.branch || "head", 100) || "head";
  const unique = crypto.randomUUID().slice(0, 8);
  return `${project}-${branch}-${options.timestamp}-${unique}.${options.extension}`;
}

/**
 * Create the context directory with owner-only access.
 *
 * `mkdir({ mode })` is ignored when the directory already exists, so the mode
 * is reapplied explicitly each run to evict a stale, more permissive mode left
 * by a previous build or another process. chmod is a no-op for permission bits
 * on Windows.
 */
async function ensureContextDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      await chmod(dir, 0o700);
    } catch {
      // Best effort — the 0o600 file mode still protects the contents.
    }
  }
}

/**
 * Reserve a path for a bundle about to be generated.
 *
 * Only the main process calls this. The path never comes from a payload or
 * from `CopyTreeOptions`, both of which are caller-controlled over MCP —
 * letting either name the destination would turn a context dump into an
 * arbitrary file write.
 */
export async function reserveContextFilePath(options: {
  worktreePath: string;
  branch?: string;
  extension: string;
}): Promise<string> {
  const dir = contextDir();
  await ensureContextDir(dir);
  // Before, not after: the new bundle is the one thing that must not be swept,
  // and pruning first keeps the directory bounded even if a run never finishes.
  await pruneContextDir();

  const filePath = path.join(
    dir,
    buildContextFileName({
      projectName: path.basename(options.worktreePath),
      branch: options.branch ?? "head",
      extension: options.extension,
      timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
    })
  );
  reservedPaths.add(filePath);
  return filePath;
}

/** Release a reserved path once its run has settled, successfully or not. */
export function releaseContextFilePath(filePath: string): void {
  reservedPaths.delete(filePath);
}

/**
 * Drop expired and surplus bundles, oldest first.
 *
 * Failures are logged and swallowed: a directory we cannot tidy is not a reason
 * to fail the generation the caller actually asked for.
 */
export async function pruneContextDir(): Promise<void> {
  const dir = contextDir();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  const candidates: { filePath: string; mtimeMs: number }[] = [];

  for (const entry of entries) {
    // Regular files in this directory only. A symlink here would let whatever
    // it points at be deleted, and recursing would take the sweep somewhere it
    // has no business being.
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    if (isProtected(filePath)) continue;

    let stats;
    try {
      stats = await stat(filePath);
    } catch {
      continue;
    }

    const age = now - stats.mtimeMs;
    const maxAge = entry.name.endsWith(PARTIAL_SUFFIX) ? MAX_PARTIAL_AGE_MS : MAX_AGE_MS;
    if (age > maxAge) {
      await removeQuietly(filePath);
      continue;
    }
    if (!entry.name.endsWith(PARTIAL_SUFFIX)) {
      candidates.push({ filePath, mtimeMs: stats.mtimeMs });
    }
  }

  if (candidates.length <= MAX_RETAINED_FILES) return;
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.filePath.localeCompare(b.filePath));
  for (const { filePath } of candidates.slice(0, candidates.length - MAX_RETAINED_FILES)) {
    await removeQuietly(filePath);
  }
}

/**
 * A reserved bundle is protected, and so is any partial named after it — the
 * writer publishes `<path>.<uuid>.part` by renaming it onto `<path>`.
 */
function isProtected(filePath: string): boolean {
  if (reservedPaths.has(filePath)) return true;
  for (const reserved of reservedPaths) {
    if (filePath.startsWith(`${reserved}.`)) return true;
  }
  return false;
}

async function removeQuietly(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch (error) {
    logWarn("Failed to prune a CopyTree context file", { error });
  }
}

/**
 * Byte ceiling on the head read back from the bundle.
 *
 * Only an upper bound on the read — the serialized budget below is what
 * actually decides how much survives.
 */
export const CONTENT_PREVIEW_MAX_BYTES = 32 * 1024;

/**
 * Byte ceiling on the whole serialized result.
 *
 * `buildToolCallTextResult` drops `structuredContent` and flags `isError` once
 * a serialized tool result passes `TOOL_RESULT_TEXT_MAX_BYTES` (50 KiB), so a
 * head sized against the raw file would defeat the opt-in it exists to serve.
 * Raw bytes are the wrong unit for that budget: JSON escaping doubles a
 * newline, a quote and a backslash, and expands most C0 controls to a six-byte
 * `\u00xx` — a 32 KiB head of the wrong file serializes to 192 KiB. So the fit
 * is measured on the serialized object, and this sits 2 KiB under the transport
 * cap to leave room for the envelope around it.
 */
export const CONTENT_RESULT_MAX_BYTES = 48 * 1024;

/**
 * Read at most `CONTENT_PREVIEW_MAX_BYTES` from the head of `filePath`.
 *
 * Positional reads into one fixed buffer, never `readFile` — the file this
 * bounds is the multi-megabyte bundle the whole change exists to keep out of
 * memory. A cut inside a multi-byte sequence would decode to U+FFFD, so the
 * tail is backed off to a UTF-8 boundary instead (a sequence is at most 4
 * bytes, so at most 3 continuation bytes can precede the cut).
 */
export async function readContentPreview(
  filePath: string,
  maxBytes: number = CONTENT_PREVIEW_MAX_BYTES
): Promise<{ content: string; truncated: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    let read = 0;
    while (read < maxBytes) {
      const { bytesRead } = await handle.read(buffer, read, maxBytes - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }

    // A short read means the file ended, so what was read is already complete.
    const truncated = read === maxBytes;
    const end = truncated ? trimToUtf8Boundary(buffer, read) : read;
    return { content: buffer.subarray(0, end).toString("utf8"), truncated };
  } finally {
    await handle.close();
  }
}

/**
 * Largest cut at or below `end` that does not land inside a UTF-8 sequence.
 *
 * The buffer stops exactly at the window, so unlike a cut made inside a larger
 * buffer there is no following byte to inspect — the last sequence has to be
 * located by walking back to its lead byte and asking whether all of it made
 * it in. A chopped tail would otherwise decode to U+FFFD.
 */
function trimToUtf8Boundary(buffer: Buffer, end: number): number {
  // A sequence is at most 4 bytes, so at most 3 continuation bytes precede the
  // lead. Anything longer is malformed input, not a boundary.
  let start = end - 1;
  for (let i = 0; i < 3 && start >= 0 && (buffer[start] & 0xc0) === 0x80; i += 1) {
    start -= 1;
  }
  if (start < 0) return 0;

  const lead = buffer[start];
  let expected = 1;
  if ((lead & 0xf8) === 0xf0) expected = 4;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xe0) === 0xc0) expected = 2;

  return start + expected <= end ? end : start;
}

/**
 * Shrink `content` until the whole result serializes within
 * `CONTENT_RESULT_MAX_BYTES`.
 *
 * `buildResult` is called with a candidate head rather than the caller
 * assembling one, because the sibling fields (`filePath`, stats) count against
 * the same budget and their size isn't known here. The search runs on code-unit
 * indices and then walks back off a lone high surrogate, so a cut never splits
 * a surrogate pair into an unpaired half.
 */
export function fitContentToResultBudget<T>(
  content: string,
  buildResult: (content: string, truncated: boolean) => T,
  alreadyTruncated: boolean,
  maxBytes: number = CONTENT_RESULT_MAX_BYTES
): { result: T; content: string; truncated: boolean } {
  const fits = (candidate: string, truncated: boolean) =>
    Buffer.byteLength(JSON.stringify(buildResult(candidate, truncated)), "utf8") <= maxBytes;

  if (fits(content, alreadyTruncated)) {
    return { result: buildResult(content, alreadyTruncated), content, truncated: alreadyTruncated };
  }

  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(content.slice(0, safeEnd(content, mid)), true)) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const fitted = content.slice(0, safeEnd(content, low));
  return { result: buildResult(fitted, true), content: fitted, truncated: true };
}

/** Back off an index that would leave a high surrogate without its pair. */
function safeEnd(value: string, end: number): number {
  if (end <= 0 || end >= value.length) return Math.max(0, Math.min(end, value.length));
  const last = value.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

/** Reset module state between tests. */
export function _resetReservedPathsForTests(): void {
  reservedPaths.clear();
}
