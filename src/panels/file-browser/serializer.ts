import type { FileBrowserPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

/**
 * Every field persists, unlike the diff panel's runtime-only change set: the
 * issue's contract is that a pinned browser keeps its root, expansion and
 * selection, and all three are user intent rather than derived data. A path
 * that has since been deleted simply doesn't resolve to a row on restore, which
 * is the same outcome as never having expanded it.
 */
export function serializeFileBrowser(t: FileBrowserPanelData): Partial<PanelSnapshot> {
  return {
    ...(t.browserSelectedPath != null && { browserSelectedPath: t.browserSelectedPath }),
    ...(t.browserExpandedPaths != null && { browserExpandedPaths: t.browserExpandedPaths }),
    ...(t.browserShowIgnored != null && { browserShowIgnored: t.browserShowIgnored }),
    // Truthiness, not `!= null`: "" is the worktree root, which is the same
    // state as the field being absent — persisting it would be noise.
    ...(t.browserRootPath ? { browserRootPath: t.browserRootPath } : {}),
  };
}
