import type { FileBrowserPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

/**
 * Every field persists, unlike the diff panel's runtime-only change set: the
 * issue's contract is that a pinned browser keeps its root, expansion,
 * selection and layout, all user intent rather than derived data — plus the
 * last-known tree snapshot (#11367), the one derived field, which must ride
 * persistence because it exists precisely to outlive the renderer. A path
 * that has since been deleted simply doesn't resolve to a row on restore,
 * which is the same outcome as never having expanded it.
 */
export function serializeFileBrowser(t: FileBrowserPanelData): Partial<PanelSnapshot> {
  return {
    ...(t.browserSelectedPath != null && { browserSelectedPath: t.browserSelectedPath }),
    ...(t.browserExpandedPaths != null && { browserExpandedPaths: t.browserExpandedPaths }),
    ...(t.browserHideDotfiles != null && { browserHideDotfiles: t.browserHideDotfiles }),
    // Truthiness, not `!= null`: "" is the worktree root, which is the same
    // state as the field being absent — persisting it would be noise.
    ...(t.browserRootPath ? { browserRootPath: t.browserRootPath } : {}),
    // Truthiness, not `!= null`: `false` is the default open state, the same as
    // the field being absent, so only a collapsed sidebar earns a persisted bit.
    ...(t.browserSidebarCollapsed ? { browserSidebarCollapsed: true } : {}),
    ...(t.browserTreeSnapshot != null && { browserTreeSnapshot: t.browserTreeSnapshot }),
  };
}
