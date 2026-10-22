import type { ContextMenuContribution } from "@shared/types/plugin";
import { extensionOf, matchesFileEditorGlob } from "@/registry/fileEditorGlob";

export interface FileMenuTarget {
  isDirectory: boolean;
  /** Worktree-relative, forward slashes. */
  relativePath: string;
  name: string;
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
    const relative = target.relativePath.replace(/\\/g, "/");
    if (!item.paths.some((pattern) => matchesFileEditorGlob(relative, pattern))) return false;
  }
  return true;
}
