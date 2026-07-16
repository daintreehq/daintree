import { isAbsolute, resolve } from "@shared/utils/path";

export interface ResolvedFilePath {
  absolutePath: string;
  line?: number;
  col?: number;
}

// Matches a file-path-like token inside arbitrary text. Every alternative
// requires a path separator ('/' or '\') and a trailing `.ext`, so bare words
// and slash-commands (`/help`, `/api/v1`) never match. Global so the terminal
// link scanner can walk every match on a line. Kept byte-for-byte identical to
// the historical FileLinksAddon regex so link-scanning behavior is unchanged.
export const FILE_PATH_REGEX =
  /(?:^|[\s(])((?:\\\\wsl(?:\$|\.localhost)\\[^\\]+(?:\\[\w.-]+)+|\/[\w./-]+|[a-zA-Z]:[\\/][\w./\\-]+|(?:\.\.?[\\/])+[\w./\\-]+|[\w-]+[\\/][\w./\\-]+)\.[\w]+(?::\d+(?::\d+)?)?)/g;

const WINDOWS_ABS = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

/** URLs and embedded escape sequences look path-ish but aren't files. */
export function isPathExcluded(text: string): boolean {
  return text.includes("://") || text.includes("\x1b");
}

/**
 * Turn a path-like token into an absolute path, stripping any `:line[:col]`
 * suffix. Relative tokens resolve against `cwd`; when `cwd` is empty a relative
 * token can't be resolved and returns null. Windows cwds join with the drive's
 * separator so a POSIX-style relative token still lands under the drive root.
 */
export function resolveFilePathCandidate(text: string, cwd: string): ResolvedFilePath | null {
  const match = /^(.*\.[^\s:]+?)(?::(\d+)(?::(\d+))?)?$/.exec(text);
  if (!match) return null;
  const pathPart = match[1];
  if (pathPart === undefined) return null;
  const line = match[2] ? Number(match[2]) : undefined;
  const col = match[3] ? Number(match[3]) : undefined;

  let absolutePath: string;
  if (isAbsolute(pathPart)) {
    absolutePath = pathPart;
  } else {
    if (!cwd) return null;
    if (WINDOWS_ABS.test(cwd)) {
      const sep = cwd.includes("\\") ? "\\" : "/";
      absolutePath = `${cwd.replace(/[\\/]+$/, "")}${sep}${pathPart.replace(/[\\/]+/g, sep)}`;
    } else {
      absolutePath = resolve(cwd, pathPart);
    }
  }

  return { absolutePath, line, col };
}

/**
 * Detect a file path from a user's text *selection* (terminal or composer). The
 * whole trimmed selection must be a single path token — a path embedded in
 * prose ("see src/foo.ts for details") is intentionally rejected so the "View
 * file" menu section only appears when the user selected exactly a path.
 */
export function resolveSelectedFilePath(selection: string, cwd: string): ResolvedFilePath | null {
  const trimmed = selection.trim();
  if (!trimmed || isPathExcluded(trimmed)) return null;
  const matches = [...trimmed.matchAll(FILE_PATH_REGEX)];
  if (matches.length !== 1) return null;
  const [match] = matches;
  if (!match || match[1] !== trimmed) return null;
  return resolveFilePathCandidate(trimmed, cwd);
}
