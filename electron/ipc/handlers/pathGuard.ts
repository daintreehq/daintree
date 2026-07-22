import * as nodePath from "path";
import * as nodeFs from "fs";
import { AppError } from "../../utils/errorTypes.js";

export { assertExtensionAllowed } from "../../utils/executablePathGuard.js";

/**
 * Resolve a renderer-supplied path and assert it is contained within one of
 * the allowed roots. Both the target and each root are run through
 * `fs.realpath` (re-resolved at call time) so symlinks can't smuggle a path
 * out of its root after the fact — the same containment idiom used by
 * `electron/ipc/handlers/files.ts` (PR #6263).
 *
 * Returns the canonical (realpath-resolved) target so callers can hand the
 * resolved path to the sink rather than the original string, shrinking the
 * TOCTOU window between check and use.
 *
 * Throws `AppError` with code `INVALID_PATH` for non-absolute or
 * unresolvable paths, and `OUTSIDE_ROOT` when the target is not contained in
 * any allowed root.
 */
export async function resolveContainedPath(
  targetPath: string,
  roots: readonly string[]
): Promise<string> {
  if (!nodePath.isAbsolute(targetPath)) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "Only absolute paths are allowed",
      context: { targetPath },
    });
  }

  let realTarget: string;
  try {
    realTarget = await nodeFs.promises.realpath(targetPath);
  } catch (error) {
    throw new AppError({
      code: "INVALID_PATH",
      message: "Could not resolve path",
      context: { targetPath },
      cause: error instanceof Error ? error : undefined,
    });
  }

  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await nodeFs.promises.realpath(root);
    } catch {
      // A stale or deleted root can't contain anything — skip it.
      continue;
    }
    // realRoot === path.sep is degenerate (realRoot + sep becomes "//", which
    // never prefix-matches); treat any absolute path as contained then.
    const contained =
      realRoot === nodePath.sep
        ? realTarget.startsWith(nodePath.sep)
        : realTarget === realRoot || realTarget.startsWith(realRoot + nodePath.sep);
    if (contained) {
      return realTarget;
    }
  }

  throw new AppError({
    code: "OUTSIDE_ROOT",
    message: "Path is outside all allowed roots",
    context: { targetPath },
  });
}
