import { promises as fs } from "fs";
import * as path from "path";
import type {
  CompletionBaseDir,
  CompletionConcreteBase,
  CompletionLocation,
} from "../../../shared/types/completionSources.js";

export interface PathResolveContext {
  home: string;
  projectRoot?: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** A path segment is safe when it names exactly one child dir/file. Rejects
 *  empty, `.`/`..`, embedded separators, NUL, and absolute segments. */
function isSafeSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.includes("\0")) return false;
  if (segment.includes("/") || segment.includes("\\")) return false;
  if (path.isAbsolute(segment)) return false;
  return true;
}

function joinValidated(base: string, segments: readonly string[]): string | null {
  for (const segment of segments) {
    if (!isSafeSegment(segment)) return null;
  }
  return segments.length > 0 ? path.join(base, ...segments) : base;
}

function resolveConcreteBase(base: CompletionConcreteBase, ctx: PathResolveContext): string | null {
  switch (base.type) {
    case "projectRoot":
      return ctx.projectRoot ?? null;
    case "absolute":
      return path.isAbsolute(base.path) ? base.path : null;
    case "homeRelative":
      return joinValidated(ctx.home, base.segments);
  }
}

function resolveBaseDir(base: CompletionBaseDir, ctx: PathResolveContext): string | null {
  if (base.type === "env") {
    const raw = ctx.env[base.name];
    // A set env value is always resolved to an absolute base. This is uniform
    // across CONFIG_DIR/CODEX_HOME/XDG/ProgramData — the old service resolved
    // only the CONFIG_DIR vars and join()-ed XDG/ProgramData; the difference is
    // visible only for the rare relative env value (an always-absolute
    // sourcePath is the intentional normalization). Absolute values (the norm)
    // are identical either way.
    if (raw) return path.resolve(raw);
    return resolveConcreteBase(base.fallback, ctx);
  }
  return resolveConcreteBase(base, ctx);
}

/**
 * Resolve a location to an absolute directory. Returns null when the location
 * doesn't apply on this platform, needs an absent project root, references an
 * unset env with an unresolvable fallback, or fails segment validation — in
 * every case the location is simply skipped (fail-closed, no thrown error).
 */
export function resolveLocationDir(
  loc: CompletionLocation,
  ctx: PathResolveContext
): string | null {
  if (loc.platforms && !(loc.platforms as readonly string[]).includes(ctx.platform)) {
    return null;
  }
  const base = resolveBaseDir(loc.base, ctx);
  if (base === null) return null;
  return joinValidated(base, loc.segments);
}

/** Walk up from `startPath` to the nearest `.git`, mirroring the former service. */
export async function resolveProjectRoot(startPath: string): Promise<string> {
  let current = path.resolve(startPath);

  try {
    const stats = await fs.stat(current);
    if (!stats.isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }

  for (let i = 0; i < 50; i++) {
    try {
      await fs.stat(path.join(current, ".git"));
      return current;
    } catch {
      // keep walking up
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return path.resolve(startPath);
}
