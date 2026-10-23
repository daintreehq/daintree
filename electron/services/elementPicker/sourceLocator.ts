import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SourceFileRefSchema,
  type SourceFileRef,
} from "../../../shared/elementPicker/resolution.js";
import type { SourceAccessResult } from "../../../shared/elementPicker/resolver.js";
import { hasControlCharacter, isStrictlyInside } from "./containment.js";
import { turbopackProjectPath, webpackModulePath } from "./nextDevServer.js";
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
  /**
   * The page runs on a Next.js dev server, whose bundlers name sources by
   * module rather than by file: Webpack from the project, as Next.js's own
   * overlay reads them, and Turbopack from its project root.
   */
  nextjs?: boolean;
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
  if (context.nextjs) {
    const located = nextSource(joined, context, paths);
    if (located !== null) return located;
  }
  // webpack://, turbopack://, virtual: and the like name modules, not files.
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") return UNSUPPORTED;

  // A map read from disk names its relative sources from where it lies.
  if (scheme === undefined && SCHEME.exec(context.base)?.[1]?.toLowerCase() === "file") {
    try {
      const url = new URL(joined, context.base);
      if (url.protocol !== "file:") return UNSUPPORTED;
      return fileRef(fileURLToPath(url, { windows: paths === path.win32 }), context, paths);
    } catch {
      return UNSUPPORTED;
    }
  }

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

/**
 * A source a Next.js bundler named by module. Webpack's identity is the file
 * relative to the project, which is the app. Turbopack's `[project]` is its
 * project root, which in a monorepo is the repository rather than the app, so
 * a path that lands in the app from the worktree is read from there and any
 * other from the app, the rule a rooted path is read by too.
 */
function nextSource(
  joined: string,
  context: MapSourceContext,
  paths: path.PlatformPath
): Located | null {
  const webpack = webpackModulePath(joined);
  if (webpack !== null) return fileRef(paths.join(context.roots.appRoot, webpack), context, paths);
  const turbopack = turbopackProjectPath(joined);
  if (turbopack === null) return null;
  const fromWorktree = paths.join(context.roots.worktreePath, turbopack);
  return fileRef(
    isStrictlyInside(context.roots.appRoot, fromWorktree, paths)
      ? fromWorktree
      : paths.join(context.roots.appRoot, turbopack),
    context,
    paths
  );
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
