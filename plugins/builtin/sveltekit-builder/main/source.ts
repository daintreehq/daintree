import path from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { BuiltinPluginFsApi, PluginFsApi } from "../../../../shared/types/plugin.js";

/**
 * Source files as main sees them: bytes, their revision, and the paths an
 * untrusted caller is allowed to name.
 */

/** No real component comes near this. The cap bounds every parse main performs. */
export const MAX_SOURCE_BYTES = 1024 * 1024;

export function sha256Hex(data: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(typeof data === "string" ? Buffer.from(data, "utf8") : data);
  return hash.digest("hex");
}

/**
 * `ignoreBOM` keeps a leading BOM as U+FEFF. Svelte's Vite plugin reads files
 * the same way, so the offsets `__svelte_meta` reports and the offsets the
 * parser produces here agree. `fatal` refuses bytes that would not survive a
 * decode/encode round trip.
 */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type SourceRead =
  /**
   * `text` never carries a leading BOM. Svelte's `parse` and `compile` strip
   * one before assigning offsets, so every AST range and every
   * `__svelte_meta` location is measured without it.
   */
  | { status: "ok"; text: string; revision: string }
  | { status: "missing" }
  | { status: "too-large" }
  | { status: "not-utf8"; revision: string };

/**
 * The bytes of a source file, or the reason there are none to parse.
 *
 * The cap used to be applied to `bytes.byteLength` — after a complete
 * `readFileBytes`, which is to say after the whole file was in main's heap. The
 * limit bounded *parsing* and nothing else, so a 400 MB file in the project
 * still cost 400 MB to refuse, and main is where the app and every other
 * plugin live.
 *
 * `readFileBounded` closes that properly: one opened descriptor, at most
 * `MAX_SOURCE_BYTES + 1` bytes read through it, and the regular-file check
 * made on that descriptor. It matters because `something.svelte` can be a
 * directory or a named pipe, and a FIFO's `size` is 0 while its read need
 * never end — a path stat would be answering about a name, not about the thing
 * the read is actually attached to.
 *
 * The stat-then-read fallback is for a handle that has no bounded read: a test
 * double, or an out-of-process host proxy. It keeps the old shape, including
 * its two acknowledged holes — a stat that throws falls through to the read,
 * and the file can grow between the stat and it, which is what the post-read
 * check catches.
 */
type SourceBytes =
  { status: "ok"; bytes: Uint8Array } | { status: "too-large" } | { status: "missing" };

async function readBoundedBytes(
  fs: BuiltinPluginFsApi,
  absolutePath: string,
  signal?: AbortSignal
): Promise<SourceBytes> {
  const bounded = fs.readFileBounded;
  if (bounded) {
    try {
      const read = await bounded.call(fs, absolutePath, {
        limitBytes: MAX_SOURCE_BYTES,
        ...(signal && { signal }),
      });
      if (read.status === "too-large") return { status: "too-large" };
      // Nothing readable as source is there, which is what `missing` means to
      // every caller: there is no text to parse and no revision to hold it to.
      if (read.status === "not-a-file") return { status: "missing" };
      return { status: "ok", bytes: read.bytes };
    } catch (error) {
      // A cancelled read is not a missing file: reporting it as one would have
      // the caller carry on as though it had looked.
      if (signal?.aborted) throw error;
      // `host.fs` cannot tell missing from denied; neither is readable source.
      return { status: "missing" };
    }
  }
  return legacyBytes(fs, absolutePath, signal);
}

async function legacyBytes(
  fs: PluginFsApi,
  absolutePath: string,
  signal?: AbortSignal
): Promise<SourceBytes> {
  const options = signal ? { signal } : undefined;
  try {
    const stat = await fs.stat(absolutePath, options);
    if (!stat.isFile) return { status: "missing" };
    if (stat.size > MAX_SOURCE_BYTES) return { status: "too-large" };
  } catch (error) {
    if (signal?.aborted) throw error;
    // An unreadable stat is not evidence of anything; the read reports the
    // truth, including whether the file is there at all.
  }
  try {
    const bytes = await fs.readFileBytes(absolutePath, options);
    // Still checked after the read: the file may have grown since the stat.
    return bytes.byteLength > MAX_SOURCE_BYTES ? { status: "too-large" } : { status: "ok", bytes };
  } catch {
    return { status: "missing" };
  }
}

export async function readSource(
  fs: BuiltinPluginFsApi,
  absolutePath: string,
  signal?: AbortSignal
): Promise<SourceRead> {
  const read = await readBoundedBytes(fs, absolutePath, signal);
  if (read.status !== "ok") return read;
  const { bytes } = read;
  const revision = sha256Hex(bytes);
  try {
    const decoded = decoder.decode(bytes);
    const bom = decoded.charCodeAt(0) === 0xfeff;
    return { status: "ok", text: bom ? decoded.slice(1) : decoded, revision };
  } catch {
    return { status: "not-utf8", revision };
  }
}

/**
 * The revision of a file the tracker is watching, under the same size cap
 * every other read here obeys.
 *
 * `null` means "not readable source", which covers a deleted file and one that
 * has grown past the cap. The tracker used to hash an uncapped
 * `readFileBytes`, so a watched file growing to any size was read and hashed in
 * full on every change the watcher reported — repeatedly, and in main. A file
 * this returns `null` for is one {@link readSource} would refuse anyway, so
 * reporting no revision is what the rest of the builder already expects.
 */
export async function readRevision(
  fs: BuiltinPluginFsApi,
  absolutePath: string,
  signal?: AbortSignal
): Promise<string | null> {
  const read = await readBoundedBytes(fs, absolutePath, signal);
  return read.status === "ok" ? sha256Hex(read.bytes) : null;
}

export type ContainedPath =
  | { ok: true; absolute: string; appRelative: string; worktreeRelative: string }
  | { ok: false; reason: "invalid" | "outside-app" };

export interface PathRoots {
  worktreePath: string;
  appRoot: string;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

function contain(roots: PathRoots, absolute: string): ContainedPath {
  const appRelative = path.relative(roots.appRoot, absolute);
  if (appRelative === "" || appRelative.startsWith("..") || path.isAbsolute(appRelative)) {
    return { ok: false, reason: "outside-app" };
  }
  return {
    ok: true,
    absolute,
    appRelative: toPosix(appRelative),
    worktreeRelative: toPosix(path.relative(roots.worktreePath, absolute)),
  };
}

/**
 * A `__svelte_meta.loc.file` from the guest. Svelte reports it relative to the
 * Vite root, which is the app root — in a monorepo that is not the worktree —
 * so it resolves there and must stay there. `host.fs` would still contain an
 * escape to the worktree, but a component outside the app is not something
 * this app's builder may claim, whatever the page says.
 */
export function resolveReportedPath(roots: PathRoots, reported: string): ContainedPath {
  if (reported.length === 0 || hasControlCharacter(reported))
    return { ok: false, reason: "invalid" };
  const absolute = path.isAbsolute(reported)
    ? path.resolve(reported)
    : path.resolve(roots.appRoot, reported);
  return contain(roots, absolute);
}

/**
 * Lexical containment cannot see a symlinked directory inside the app that
 * points elsewhere in the worktree, and `host.fs` only contains to the
 * worktree. Both ends are resolved on disk before anything is read. Only
 * paths are resolved here; content still goes through `host.fs`.
 */
export async function containsRealPath(appRoot: string, absolute: string): Promise<boolean> {
  try {
    const [root, target] = await Promise.all([realpath(appRoot), realpath(absolute)]);
    const relative = path.relative(root, target);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

/**
 * Generated-file detection is a string test; on a case-insensitive filesystem
 * `NODE_MODULES/` names the same directory, so the check runs on both spellings.
 */
export function isGeneratedPath(
  isGenerated: (file: string) => boolean,
  appRelative: string
): boolean {
  return isGenerated(appRelative) || isGenerated(appRelative.toLowerCase());
}
