import type { WorkspaceListEntry } from "@shared/types/ipc/workspace";

/**
 * The workspace discovery catalog (#12307).
 *
 * Uncached on purpose: `hasLiveView` changes whenever a window opens, closes or
 * evicts a view, and a cached answer would report a stale one as fact.
 */
export const workspaceClient = {
  list: (): Promise<WorkspaceListEntry[]> => {
    return window.electron.workspace.list();
  },
};
