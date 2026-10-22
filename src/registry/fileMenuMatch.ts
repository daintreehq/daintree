import type { ContextMenuContribution } from "@shared/types/plugin";
import { extensionOf, matchesFileEditorGlob } from "@/registry/fileEditorGlob";

export interface FileMenuTarget {
  isDirectory: boolean;
  /** Worktree-relative, forward slashes. */
  relativePath: string;
  name: string;
}

/**
 * A file outside every worktree reaches the menu with a display or absolute
 * path as its `relativePath`; that is not a worktree-relative path and must
 * neither match a `paths` glob nor be dispatched as one.
 */
export function isWorktreeRelativePath(relativePath: string): boolean {
  return relativePath !== "" && !/^([/\\]|[a-zA-Z]:)/.test(relativePath);
}

type FileMenuMatchFields = Pick<ContextMenuContribution, "kind" | "extensions" | "paths">;

/**
 * Whether a `location: "file"` contribution's declarative match admits the
 * clicked row. Every declared field must hold; an omitted field admits all.
 */
export function matchesFileMenuTarget(item: FileMenuMatchFields, target: FileMenuTarget): boolean {
  if (item.kind && (item.kind === "folder") !== target.isDirectory) return false;
  if (item.extensions) {
    if (target.isDirectory) return false;
    const ext = extensionOf(target.name);
    if (ext === null || !item.extensions.includes(ext)) return false;
  }
  if (item.paths) {
    if (!isWorktreeRelativePath(target.relativePath)) return false;
    const relative = target.relativePath.replace(/\\/g, "/");
    if (!item.paths.some((pattern) => matchesFileEditorGlob(relative, pattern))) return false;
  }
  return true;
}
