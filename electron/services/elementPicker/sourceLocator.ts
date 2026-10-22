import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SourceFileRefSchema,
  type SourceFileRef,
} from "../../../shared/elementPicker/resolution.js";
import type { SourceAccessResult } from "../../../shared/elementPicker/resolver.js";
import { hasControlCharacter, isStrictlyInside } from "./containment.js";
import type { SourceRoots } from "./sourceAccess.js";

/**
 * Turns a source a map names into a file in the workspace, in main, because
 * only main holds the roots. Lexical only: nothing is read, and a read of the
 * ref is contained again on disk. The host sends the source raw, since
 * resolving it against the map's URL first is what turns `C:\app\Card.tsx` or
 * `/home/me/app/Card.tsx` into a path on the dev server.
 */

export interface MapSourceContext {
  workspaceId: string;
  roots: SourceRoots;
  /** The authorised preview origin, as `URL.origin` gives it. */
  previewOrigin: string;
  /** What a relative source resolves against: the map's URL, or the module's for an inline map. */
  base: string;
  /** The platform's own except in tests that hold Windows paths to the same rules. */
  paths?: path.PlatformPath;
}

type Located = SourceAccessResult<SourceFileRef>;

const UNSUPPORTED: Located = { ok: false, reason: "unsupported" };
const OUTSIDE: Located = { ok: false, reason: "outside-workspace" };

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** ECMA-426: a non-empty `sourceRoot` is a directory, prefixed to the source as it stands. */
export function joinSourceRoot(source: string, sourceRoot: string | null): string {
  if (!sourceRoot) return source;
  return `${sourceRoot.endsWith("/") ? sourceRoot : `${sourceRoot}/`}${source}`;
}

export function locateMapSource(
  source: string,
  sourceRoot: string | null,
  context: MapSourceContext
): Located {
  const paths = context.paths ?? path;
  const joined = joinSourceRoot(source, sourceRoot);
  // A NUL is how Rollup and Vite mark a virtual module, and no file is named with one.
  if (joined === "" || hasControlCharacter(joined)) return UNSUPPORTED;

  if (WINDOWS_ABSOLUTE.test(joined)) return fileRef(joined, context, paths);
  const scheme = SCHEME.exec(joined)?.[1]?.toLowerCase();
  if (scheme === "file") {
    try {
      return fileRef(fileURLToPath(joined, { windows: paths === path.win32 }), context, paths);
    } catch {
      return UNSUPPORTED;
    }
  }
  // webpack://, turbopack://, virtual: and the like name modules, not files.
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") return UNSUPPORTED;

  // A rooted source is a URL path by the spec, but tools that write absolute
  // filesystem paths write them the same way. One that lands inside the
  // worktree as a path is read as one: a dev server root holding a copy of the
  // worktree's own absolute path is not a layout anyone has.
  if (
    paths.sep === "/" &&
    joined.startsWith("/") &&
    !joined.startsWith("//") &&
    isStrictlyInside(context.roots.worktreePath, paths.resolve(joined), paths)
  ) {
    return fileRef(joined, context, paths);
  }
  return urlRef(joined, context, paths);
}

function urlRef(joined: string, context: MapSourceContext, paths: path.PlatformPath): Located {
  let url: URL;
  try {
    url = new URL(joined, context.base);
  } catch {
    return UNSUPPORTED;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return UNSUPPORTED;
  if (url.origin !== context.previewOrigin) return OUTSIDE;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return UNSUPPORTED;
  }
  if (hasControlCharacter(pathname)) return UNSUPPORTED;

  // Vite serves a file outside its root as `/@fs/` plus its absolute path,
  // which on Windows keeps the drive: `/@fs/C:/app/Card.tsx`.
  if (pathname.startsWith("/@fs/")) {
    const absolute = pathname.slice("/@fs".length);
    return fileRef(/^\/[A-Za-z]:\//.test(absolute) ? absolute.slice(1) : absolute, context, paths);
  }
  // `/@id/` and `__x00__` are Vite's virtual modules; `/@vite/` and the like its own runtime.
  if (pathname.startsWith("/@") || pathname.includes("__x00__")) return UNSUPPORTED;
  // Anything else on the dev server is served from its root, which is the app's.
  return fileRef(paths.join(context.roots.appRoot, ...pathname.split("/")), context, paths);
}

function fileRef(candidate: string, context: MapSourceContext, paths: path.PlatformPath): Located {
  // A rooted Windows path with no drive would take the drive of whatever
  // directory main happens to run in.
  if (paths === path.win32 ? !WINDOWS_ABSOLUTE.test(candidate) : !paths.isAbsolute(candidate)) {
    return OUTSIDE;
  }
  const absolute = paths.resolve(candidate);
  if (!isStrictlyInside(context.roots.appRoot, absolute, paths)) return OUTSIDE;
  const relative = paths.relative(context.roots.worktreePath, absolute).split(paths.sep).join("/");
  const ref = SourceFileRefSchema.safeParse({ workspaceId: context.workspaceId, path: relative });
  return ref.success ? { ok: true, value: ref.data } : OUTSIDE;
}
