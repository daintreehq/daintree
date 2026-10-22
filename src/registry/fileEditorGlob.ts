/**
 * The glob grammar a project plugin's `contributes.fileEditors[].paths` speaks
 * (#13809), matched against a forward-slash path relative to the project or
 * worktree root. Deliberately small, so a claim reads the same to the person
 * auditing the manifest as it does here:
 *
 * - `**` as a whole segment matches zero or more directories;
 * - `*` matches any run of characters within one segment;
 * - `?` matches one character within one segment;
 * - everything else is literal and case-sensitive — no braces, classes or
 *   negation.
 *
 * Hand-rolled rather than minimatch so the file panel's chunk doesn't carry a
 * general glob engine for a feature most projects never use.
 */
const cache = new Map<string, RegExp>();

function segmentSource(segment: string): string {
  let out = "";
  for (const char of segment) {
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

export function fileEditorGlobToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const segments = pattern.split("/");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
    } else {
      source += segmentSource(segment) + (last ? "" : "/");
    }
  });
  const regExp = new RegExp(`^${source}$`);
  cache.set(pattern, regExp);
  return regExp;
}

export function matchesFileEditorGlob(relativePath: string, pattern: string): boolean {
  return fileEditorGlobToRegExp(pattern).test(relativePath);
}

/**
 * `filePath` relative to `rootPath` with forward slashes, or null when it is
 * not under the root — a path claim never reaches outside the project.
 */
export function relativeFilePath(rootPath: string, filePath: string): string | null {
  if (!rootPath || !filePath) return null;
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = norm(rootPath);
  const file = norm(filePath);
  if (!file.startsWith(root + "/")) return null;
  const relative = file.slice(root.length + 1);
  if (relative.length === 0 || relative.split("/").includes("..")) return null;
  return relative;
}
