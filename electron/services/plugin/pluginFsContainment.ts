import path from "path";
import { realpath } from "fs/promises";

/**
 * Realpath-based containment for the host-mediated `host.fs`/`host.git` surface.
 * Mirrors the `plugin://` protocol handler's discipline (electron/setup/protocols.ts):
 * normalize → reject `..` segments → realpath both the candidate and the allowed
 * roots → `path.relative` containment. A symlink that resolves outside every
 * allowed root is rejected (CVE-2025-53109 / -54794 class), closing the gap that
 * `scopes.fs.allowedPaths` left open when it was advisory-only.
 *
 * `allowedPaths` are the plugin's declared `scopes.fs.allowedPaths` — already
 * validated at the manifest gate to be absolute, `..`-free, glob-free literals.
 */

/** Thrown when a path argument resolves outside every declared allowed root. */
export class PluginPathNotAllowedError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly requestedPath: string
  ) {
    super(
      `PATH_NOT_ALLOWED: plugin "${pluginId}" path "${requestedPath}" is outside the declared scopes.fs.allowedPaths`
    );
    this.name = "PluginPathNotAllowedError";
  }
}

function isContainedRel(rel: string): boolean {
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/**
 * Resolve `requestedPath` and assert it is contained inside one of
 * `allowedPaths`. Returns the realpath-resolved absolute path on success, or
 * throws {@link PluginPathNotAllowedError}.
 *
 * A non-existent leaf (e.g. a `writeFile` target that doesn't exist yet) is
 * handled by realpath-resolving the nearest existing ancestor and re-appending
 * the missing tail, then containing the lexical join — so a write can create a
 * new file inside an allowed root without the realpath of a not-yet-existent
 * path throwing ENOENT. Each allowed root must itself realpath (a root that
 * doesn't exist on disk cannot contain anything).
 */
export async function resolveContainedPath(
  pluginId: string,
  requestedPath: string,
  allowedPaths: readonly string[]
): Promise<string> {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new PluginPathNotAllowedError(pluginId, String(requestedPath));
  }
  if (requestedPath.includes("\0")) {
    throw new PluginPathNotAllowedError(pluginId, requestedPath);
  }
  if (!path.isAbsolute(requestedPath)) {
    // host.fs takes absolute paths; a relative one has no anchor and is rejected
    // rather than silently resolved against an arbitrary cwd.
    throw new PluginPathNotAllowedError(pluginId, requestedPath);
  }

  const normalized = path.normalize(requestedPath);
  if (normalized.split(path.sep).some((seg) => seg === "..")) {
    throw new PluginPathNotAllowedError(pluginId, requestedPath);
  }

  // Realpath-resolve the nearest existing ancestor, then re-append the missing
  // tail so a write target that doesn't exist yet still contains correctly.
  const { realBase, tail } = await realpathNearest(normalized);
  const realCandidate = tail.length > 0 ? path.join(realBase, tail) : realBase;

  for (const root of allowedPaths) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      // A declared root that doesn't exist on disk cannot contain anything.
      continue;
    }
    const rel = path.relative(realRoot, realCandidate);
    if (isContainedRel(rel)) {
      return realCandidate;
    }
  }

  throw new PluginPathNotAllowedError(pluginId, requestedPath);
}

/**
 * Realpath the deepest existing prefix of `absPath`, returning that real base
 * plus the lexical tail of components that don't exist yet. This makes a write
 * to a not-yet-existent file containable: we resolve symlinks on the real part
 * and treat the missing leaf lexically (it can't be a symlink — it doesn't exist).
 */
async function realpathNearest(absPath: string): Promise<{ realBase: string; tail: string }> {
  let current = absPath;
  const missing: string[] = [];
  for (;;) {
    try {
      const realBase = await realpath(current);
      return { realBase, tail: missing.length > 0 ? path.join(...missing.reverse()) : "" };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without resolving anything — treat the
        // whole path lexically. Containment below will still reject it unless an
        // allowed root realpaths to an ancestor, which is effectively impossible
        // here, so this is a safe fail-closed fallthrough.
        return {
          realBase: current,
          tail: missing.length > 0 ? path.join(...missing.reverse()) : "",
        };
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
