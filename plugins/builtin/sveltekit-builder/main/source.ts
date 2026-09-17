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

export async function readSource(fs: PluginFsApi, absolutePath: string): Promise<SourceRead> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFileBytes(absolutePath);
  } catch {
    // `host.fs` cannot tell missing from denied; neither is readable source.
    return { status: "missing" };
  }
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
 * A worktree-relative POSIX path from the view (`sourceExcerpt`). Absolute
 * paths are refused outright rather than contained: the wire form is relative
 * by contract, and accepting both would give one file two spellings.
 */
export function resolveWorktreePath(roots: PathRoots, file: string): ContainedPath {
  if (file.length === 0 || hasControlCharacter(file)) return { ok: false, reason: "invalid" };
  if (path.posix.isAbsolute(file) || path.win32.isAbsolute(file)) {
    return { ok: false, reason: "invalid" };
  }
  return contain(roots, path.resolve(roots.worktreePath, ...file.split("/")));
}

/**
 * The inverse of the source model's `lineColumnToOffset`: 1-indexed line,
 * 0-indexed column, LF-counted, so a CR stays on the line it ends.
 */
export function offsetToLocation(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let index = source.indexOf("\n");
  while (index !== -1 && index < offset) {
    line++;
    index = source.indexOf("\n", index + 1);
  }
  return { line, column: offset - (source.lastIndexOf("\n", offset - 1) + 1) };
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
