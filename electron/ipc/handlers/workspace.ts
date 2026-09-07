import { projectStore } from "../../services/ProjectStore.js";
import { scratchStore } from "../../services/ScratchStore.js";
import { getRegisteredProjectViews } from "../../window/webContentsRegistry.js";
import { isScratchWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import { defineIpcNamespace, op } from "../define.js";
import { WORKSPACE_METHOD_CHANNELS } from "./workspace.preload.js";
import type { WorkspaceListEntry } from "../../../shared/types/ipc/workspace.js";

/**
 * The workspace discovery catalog behind the `workspace.list` action (#12307).
 *
 * Joined here rather than in the renderer because all three sources are
 * main-process state — two stores and the cross-window view registry — and
 * joining in the renderer would mean three IPC round trips whose answers could
 * disagree, plus a wider payload crossing the bridge than the five fields the
 * external contract permits.
 *
 * Lives in its own `defineIpcNamespace` block so its `IpcInvokeMap` entry is
 * codegen-generated; new channels must not grow the hand-written ratchet
 * (`check:ipc-handwritten`).
 */
export const workspaceNamespace = defineIpcNamespace({
  name: "workspace",
  ops: {
    list: op(WORKSPACE_METHOD_CHANNELS.list, async (): Promise<WorkspaceListEntry[]> => {
      // Cross-window and cache-inclusive on purpose. A per-window
      // `ProjectViewManager.getAllViews()` check (`projectCrud/switch.ts`) sees
      // one window, and `collectActiveProjectIds()` sees only foreground views;
      // either would report a backgrounded-but-open workspace as closed. This
      // registry is also the breadth `rendererBridge` already treats as live
      // when it resolves a binding, so the flag and the routing agree.
      const liveWorkspaceIds = new Set(
        getRegisteredProjectViews().map(({ projectId }) => projectId)
      );

      // Scratches are registered through the same `switchTo` path as projects,
      // so one set covers both kinds.
      const rows = [...projectStore.getAllProjectIdentities(), ...scratchStore.getAllScratches()];

      return rows
        .map(({ id, path, name }): WorkspaceListEntry => ({
          workspaceId: id,
          path,
          name,
          kind: isScratchWorkspaceId(id) ? "scratch" : "project",
          hasLiveView: liveWorkspaceIds.has(id),
        }))
        .sort((a, b) =>
          a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0
        );
    }),
  },
});

export function registerWorkspaceHandlers(): () => void {
  return workspaceNamespace.register();
}
