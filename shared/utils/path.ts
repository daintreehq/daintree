// Cross-platform path utilities for use in both main and renderer processes.
// Always emit forward-slash separators regardless of host OS so output is
// stable across platforms (renderer has no access to Node's `path` module).

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ONLY = /^[A-Za-z]:$/;
const WINDOWS_DRIVE_ROOT = /^[A-Za-z]:\/?$/;
const ABSOLUTE_PREFIX = /^([A-Za-z]:[\\/]|[\\/]{2}|[\\/])/;
// UNC roots: `//`, `//server`, or `//server/share`. The share component
// (when present) is the unescapable root floor — matches `path.win32` semantics.
const UNC_ROOT_EXACT = /^\/\/[^/]*(\/[^/]+)?$/;

export function isAbsolute(input: string): boolean {
  return ABSOLUTE_PREFIX.test(input);
}

export function normalize(input: string): string {
  if (input.length === 0) return ".";
  const source = input.replace(/\\/g, "/");

  let prefix = "";
  let rest = source;

  if (source.startsWith("//")) {
    // UNC path (\\server\share or //server/share) — `\\server\share` is the
    // unescapable root: `..` cannot pop above the share. Anchor the prefix at
    // the share boundary so the segment pop logic treats it as the floor.
    const afterDoubleSlash = source.slice(2);
    const slashIndex = afterDoubleSlash.indexOf("/");
    if (slashIndex === -1) {
      // Just "//server" (or "//") — entire input is the root
      prefix = source;
      rest = "";
    } else {
      const server = afterDoubleSlash.slice(0, slashIndex);
      const remainder = afterDoubleSlash.slice(slashIndex + 1);
      const nextSlash = remainder.indexOf("/");
      if (nextSlash === -1) {
        // "//server/share" — entire input is the root
        prefix = source;
        rest = "";
      } else {
        const share = remainder.slice(0, nextSlash);
        prefix = `//${server}/${share}`;
        rest = remainder.slice(nextSlash + 1);
      }
    }
  } else if (WINDOWS_DRIVE_PREFIX.test(source)) {
    prefix = source.slice(0, 3);
    rest = source.slice(3);
  } else if (source.startsWith("/")) {
    prefix = "/";
    rest = source.slice(1);
  }

  const segments = rest.split("/").filter((segment) => segment.length > 0);
  const normalizedSegments: string[] = [];

  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (
        normalizedSegments.length > 0 &&
        normalizedSegments[normalizedSegments.length - 1] !== ".."
      ) {
        normalizedSegments.pop();
      } else if (!prefix) {
        normalizedSegments.push("..");
      }
      continue;
    }
    normalizedSegments.push(segment);
  }

  const joined = normalizedSegments.join("/");

  if (prefix) {
    if (!joined) return prefix;
    return prefix.endsWith("/") ? `${prefix}${joined}` : `${prefix}/${joined}`;
  }

  return joined || ".";
}

/**
 * True when `child` (after normalization) is `parent` itself or nested under
 * it. Comparison is separator-normalized and purely lexical — callers that
 * need symlink-safe containment must realpath first (the files IPC handler
 * and daintree-file:// protocol both do).
 */
export function isPathInside(child: string, parent: string): boolean {
  const normalizedChild = normalize(child);
  const normalizedParent = normalize(parent);
  if (normalizedChild === "." || normalizedParent === ".") return false;
  if (normalizedChild === normalizedParent) return true;
  const parentWithSlash = normalizedParent.endsWith("/")
    ? normalizedParent
    : `${normalizedParent}/`;
  return normalizedChild.startsWith(parentWithSlash);
}

/**
 * Strip the worktree root off an absolute path. `isPathInside` is what makes
 * this safe: a raw `startsWith` accepts a sibling whose name merely extends the
 * root (`/repo-other/x.ts` under `/repo`, which then mangles into `-other/x.ts`)
 * and ignores separator normalization. A path outside the worktree passes
 * through untouched — callers reject it downstream with a real error, which
 * beats inventing a second failure mode here.
 */
export function toWorktreeRelative(path: string, worktreeRoot: string | undefined): string {
  if (!worktreeRoot || !isPathInside(path, worktreeRoot)) return path;
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(worktreeRoot);
  if (normalizedPath === normalizedRoot) return path;
  const boundary = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  return normalizedPath.slice(boundary.length);
}

export function basename(input: string): string {
  const normalized = normalize(input);
  if (
    normalized === "/" ||
    WINDOWS_DRIVE_ROOT.test(normalized) ||
    UNC_ROOT_EXACT.test(normalized)
  ) {
    return "";
  }
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "";
}

export function dirname(input: string): string {
  const normalized = normalize(input);
  if (
    normalized === "/" ||
    WINDOWS_DRIVE_ROOT.test(normalized) ||
    UNC_ROOT_EXACT.test(normalized)
  ) {
    return normalized;
  }

  const parts = normalized.split("/");
  parts.pop();
  const dir = parts.join("/");

  if (!dir) {
    return isAbsolute(normalized) ? "/" : ".";
  }
  // When the parent is just a drive letter (e.g., "C:"), append the slash so
  // callers get "C:/" — the drive root — rather than the bare prefix.
  if (WINDOWS_DRIVE_ONLY.test(dir)) {
    return `${dir}/`;
  }
  return dir;
}

export function resolve(...paths: string[]): string {
  let resolved = "";
  for (const segment of paths) {
    if (!segment) continue;
    if (isAbsolute(segment)) {
      resolved = segment;
    } else {
      resolved = resolved ? `${resolved}/${segment}` : segment;
    }
  }
  return normalize(resolved || ".");
}

// Concatenate segments with `/` separators, then normalize. Unlike `resolve`,
// an absolute later segment does NOT reset the path — `join("/a", "/b")`
// returns `"/a/b"`, not `"/b"`.
export function join(...paths: string[]): string {
  const filtered = paths.filter((segment) => segment.length > 0);
  if (filtered.length === 0) return ".";
  return normalize(filtered.join("/"));
}
