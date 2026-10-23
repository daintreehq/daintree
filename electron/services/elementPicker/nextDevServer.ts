import type { SelectionObservation } from "../../../shared/elementPicker/observation.js";

/**
 * How a Next.js dev server names the modules a React stack runs through, and
 * which of its private routes may be asked about them. Pure, so the host
 * process and main read a frame the same way: the host to choose what to ask
 * for, main to decide what that may fetch.
 *
 * React's Flight client fakes each server frame as a call into a function
 * whose `sourceURL` wraps the server's own file name,
 * `about://React/<env>/<encodeURI(file)>?<n>` in React 19.3 and
 * `rsc://React/…` before it, the counter making each fake function's URL
 * unique. Given no map URL for the function, Flight names the file bare.
 * Webpack runs a dev module under `webpack-internal:///(<layer>)/./<path>`,
 * which no request can fetch: its code lives in the compilation.
 */

const WRAPPED = /^(?:about|rsc):\/\/React\/[^/]*\/(.+?)(?:\?\d+)?$/;
const WEBPACK_INTERNAL = /^webpack-internal:\/\/\//;

/**
 * Next.js's own prefixes for a Webpack module's identity, which its overlay
 * strips to name the file relative to the project (`formatFrameSourceFile`).
 */
const WEBPACK_PREFIXES = [
  /^webpack-internal:\/\/\/(\([\w-]+\)\/)?/,
  /^(webpack:\/\/\/|webpack:\/\/(_N_E\/)?)(\([\w-]+\)\/)?/,
];

/** The route a Next.js dev server answers with the raw map of a module only it holds. */
export const NEXT_SOURCE_MAP_ROUTE = "/__nextjs_source-map";

/**
 * The majors whose private dev routes this was written against. The routes
 * have moved between releases before, so any other major, a future one
 * included, is asked nothing of them.
 */
export const NEXT_ROUTE_MAJORS: ReadonlySet<number> = new Set([16]);

/** The server's own file a wrapped frame names, decoded; null for a URL that is not one. */
export function serverFrameFile(url: string): string | null {
  const match = WRAPPED.exec(url);
  if (match === null) return null;
  try {
    return decodeURI(match[1]!);
  } catch {
    return null;
  }
}

/**
 * The one name every frame in a server file is asked for its map by: the
 * wrapper with one fixed counter, so one file costs one request however many
 * frames it has, and a numeric query of the file's own is never read as the
 * counter when main unwraps it again.
 */
export function serverMapKey(file: string): string {
  return `about://React/Server/${encodeURI(file)}?0`;
}

export function isWebpackModule(url: string): boolean {
  return WEBPACK_INTERNAL.test(url);
}

export function isFileUrl(url: string): boolean {
  return /^file:/i.test(url);
}

/** An absolute path as a server names its own files: POSIX, a Windows drive, or a UNC share. */
export function isAbsolutePath(name: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(name);
}

/**
 * The project-relative path a Webpack module identity names, with any
 * resource query left off; null for anything else. A name, not a position:
 * the module's code is Webpack's transform of the file, not its lines.
 */
export function webpackModulePath(identity: string): string | null {
  if (!/^webpack(?:-internal)?:/.test(identity)) return null;
  let path = identity;
  for (const prefix of WEBPACK_PREFIXES) path = path.replace(prefix, "");
  path = path.replace(/[?#].*$/, "");
  return path === "" || path === identity ? null : path;
}

/**
 * A Turbopack source named from its project root, `[project]/…`, with or
 * without the `turbopack:///` scheme its maps write; null for anything else.
 */
export function turbopackProjectPath(source: string): string | null {
  const match = /^(?:turbopack:\/\/\/)?\[project\]\/(.+)$/.exec(source);
  return match ? match[1]! : null;
}

/** What one resolve may assume of the page's dev server, from what the page said of itself. */
export interface NextDevServer {
  /** The page reported a major whose private routes may be asked. */
  routes: boolean;
}

/**
 * Next.js as the request's observations report it, or null for a page that
 * reported nothing of Next.js. The version is the page's own claim; the most
 * it can buy is that the dev server's own origin is asked a fixed route.
 */
export function nextDevServer(observations: readonly SelectionObservation[]): NextDevServer | null {
  let reported = false;
  let routes = false;
  for (const observation of observations) {
    for (const evidence of observation.frameworkEvidence) {
      if (evidence.kind !== "generic" || evidence.framework !== "react") continue;
      for (const { name, value } of evidence.fields) {
        if (name !== "nextVersion" && name !== "nextRouter") continue;
        reported = true;
        if (name !== "nextVersion" || typeof value !== "string") continue;
        const major = /^(\d{1,4})\./.exec(value)?.[1];
        if (major !== undefined && NEXT_ROUTE_MAJORS.has(Number(major))) routes = true;
      }
    }
  }
  return reported ? { routes } : null;
}

/**
 * What a frame's map is asked for by, in order. A server frame is asked first
 * by its wrapper, which only the dev server's route can answer, then, when
 * the server named a file, by the file, whose map lies beside it on disk.
 */
export function frameMapNames(url: string): { url: string; alternates: string[] } {
  const file = serverFrameFile(url);
  if (file === null) return { url, alternates: [] };
  return {
    url: serverMapKey(file),
    alternates: isFileUrl(file) || isAbsolutePath(file) ? [file] : [],
  };
}
