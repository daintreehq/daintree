import path from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { PluginFsApi } from "../../../../shared/types/plugin.js";

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
 * What a stat can settle before a byte is read.
 *
 * The cap used to be applied to `bytes.byteLength` — after a complete
 * `readFileBytes`, which is to say after the whole file was in main's heap. The
 * limit bounded *parsing* and nothing else, so a 400 MB file in the project
 * still cost 400 MB to refuse, and main is where the app and every other
 * plugin live.
 *
 * `not-a-file` is the case worth naming: `something.svelte` can be a directory
 * or a named pipe, and a FIFO's `size` is 0 while its read need never end — the
 * cap would be satisfied by a stream that blocks or supplies as much as it
 * likes. Only a regular file gets as far as a read.
 *
 * A stat is not a complete bound on a regular file: it can grow between this
 * call and the read, and the post-read check in {@link readSource} is what
 * catches that. Closing the window entirely needs a read that stops at
 * limit-plus-one bytes, which `host.fs` does not offer — adding it is a change
 * to the published plugin API rather than something to slip in here. This turns
 * the ordinary case from "allocate it all, then refuse" into "refuse", and
 * leaves one read of a file that was under the cap a moment ago.
 */
async function preflight(
  fs: PluginFsApi,
  absolutePath: string
): Promise<"ok" | "too-large" | "not-a-file"> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile) return "not-a-file";
    return stat.size > MAX_SOURCE_BYTES ? "too-large" : "ok";
  } catch {
    // An unreadable stat is not evidence of anything; the read reports the
    // truth, including whether the file is there at all.
    return "ok";
  }
}

export async function readSource(fs: PluginFsApi, absolutePath: string): Promise<SourceRead> {
  const before = await preflight(fs, absolutePath);
  if (before === "too-large") return { status: "too-large" };
  // Nothing readable as source is there, which is what `missing` means to
  // every caller: there is no text to parse and no revision to hold it to.
  if (before === "not-a-file") return { status: "missing" };
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFileBytes(absolutePath);
  } catch {
    // `host.fs` cannot tell missing from denied; neither is readable source.
    return { status: "missing" };
  }
  // Still checked after the read: the file may have grown since the stat.
  if (bytes.byteLength > MAX_SOURCE_BYTES) return { status: "too-large" };
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
export async function readRevision(fs: PluginFsApi, absolutePath: string): Promise<string | null> {
  if ((await preflight(fs, absolutePath)) !== "ok") return null;
  try {
    const bytes = await fs.readFileBytes(absolutePath);
    if (bytes.byteLength > MAX_SOURCE_BYTES) return null;
    return sha256Hex(bytes);
  } catch {
    return null;
  }
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
