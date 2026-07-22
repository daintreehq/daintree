import type { CopyTreeOptions } from "@shared/types/ipc/copyTree";

type CopyTreeFormat = NonNullable<CopyTreeOptions["format"]>;

export const DEFAULT_COPYTREE_FORMAT: CopyTreeFormat = "xml";

/**
 * CopyTree include pattern selecting everything under one folder.
 *
 * The include list is minimatch patterns, so the folder name has to be
 * escaped as a literal before the `/**` glob is appended — `src/[draft]`
 * would otherwise match `src/d`, and a leading `!` would negate the whole
 * pattern. Backslash escaping is safe cross-platform here because the
 * matched paths are always forward-slash worktree-relative.
 */
export function folderIncludePattern(relativePath: string): string {
  return `${relativePath.replace(/[*?[\]{}()!+@|#]/g, "\\$&")}/**`;
}
