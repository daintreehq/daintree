import { create } from "zustand";
import type { ProjectGroup, ProjectListSortMode } from "@shared/types/project";
import { projectGroupsClient } from "@/clients/projectGroupsClient";
import { sortProjectGroups } from "@/lib/projectGroupBands";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { onHostResync } from "@/store/hostResyncSignal";

/**
 * The project switcher's dialogs for naming and deleting groups. Held here
 * rather than in the palette so a context-menu item deep in a row can open one
 * without threading a callback through every surface that renders the list.
 */
export type ProjectGroupDialog =
  | { kind: "create"; projectId?: string; returnTo?: "manage" }
  | { kind: "rename"; groupId: string; returnTo?: "manage"; returnIndex?: number }
  | { kind: "delete"; groupId: string; returnTo?: "manage"; returnIndex?: number }
  /**
   * Every group in one keyboard-reachable list: rename, reorder, delete.
   * `focusGroupId` is the group a dialog opened from here was about, so coming
   * back lands on that row (or, after a delete, on the row that took its place).
   */
  | { kind: "manage"; focusGroupId?: string; focusIndex?: number };

interface ProjectGroupsState {
  /** Every group, in render order. Mirrors the host; never persisted here. */
  groups: ProjectGroup[];
  dialog: ProjectGroupDialog | null;
  /** Idempotent: pulls the list once and follows live updates from then on. */
  init: () => void;
  openDialog: (dialog: ProjectGroupDialog) => void;
  /** Closes the dialog — back to Manage groups when that is where it came from. */
  closeDialog: () => void;
  /**
   * Creates a group, filing `projectId` under it when given. Rejects with the
   * host's message (an empty or duplicate name) so a dialog can show it inline.
   */
  createGroup: (name: string, projectId?: string) => Promise<ProjectGroup>;
  /** Rejects with the host's message, for the same reason as {@link createGroup}. */
  renameGroup: (groupId: string, name: string) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  /** Moves a group one place up (-1) or down (+1). A move off either end does nothing. */
  moveGroup: (groupId: string, delta: -1 | 1) => Promise<void>;
  setGroupSortMode: (groupId: string, sortMode: ProjectListSortMode) => Promise<void>;
  /** Files a project under a group, or back into Other projects with `null`. */
  setProjectGroup: (projectId: string, groupId: string | null) => Promise<void>;
  setProjectArchived: (projectId: string, archived: boolean) => Promise<void>;
}

let subscribed = false;
/** True once a pull has landed; until then every `init()` tries again. */
let loaded = false;
// Bumped by every push. A pull only applies if no push arrived while it was in
// flight — the push is newer than whatever the pull read.
let pushSeq = 0;

/**
 * Runs an operation the user can't otherwise see failing, and says so with one
 * way to try it again.
 */
async function withRetry(title: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const retry = () => void withRetry(title, operation);
    notify({
      type: "error",
      title,
      message: formatErrorMessage(error, title),
      actions: [{ label: "Try again", variant: "primary", onClick: retry }],
      // Filing is organisation the user chose, routed like any other saved
      // preference that failed to stick.
      context: { eventKind: "settings" },
    });
  }
}

export const useProjectGroupsStore = create<ProjectGroupsState>((set, get) => {
  const applyGroups = (groups: ProjectGroup[]) => set({ groups: sortProjectGroups(groups) });

  return {
    groups: [],
    dialog: null,

    init: () => {
      const pull = () => {
        const startedAt = pushSeq;
        projectGroupsClient
          .list()
          .then((groups) => {
            loaded = true;
            if (pushSeq === startedAt) applyGroups(groups);
          })
          .catch((error) => logError("Failed to load project groups", error));
      };
      if (!subscribed) {
        subscribed = true;
        projectGroupsClient.onUpdate((groups) => {
          pushSeq += 1;
          applyGroups(groups);
        });
        // A remote view's link dropping can lose pushes on the way back: the
        // list is fetched again rather than trusted.
        onHostResync(pull);
      }
      if (!loaded) pull();
    },

    openDialog: (dialog) => set({ dialog }),
    closeDialog: () =>
      set((state) => ({
        dialog:
          state.dialog && "returnTo" in state.dialog && state.dialog.returnTo === "manage"
            ? {
                kind: "manage",
                focusGroupId: "groupId" in state.dialog ? state.dialog.groupId : undefined,
                focusIndex: "returnIndex" in state.dialog ? state.dialog.returnIndex : undefined,
              }
            : null,
      })),

    createGroup: async (name, projectId) => {
      const group = await projectGroupsClient.create(name);
      // The host's push carries the list too, but applying the answer here
      // means the new header is on screen the moment the dialog closes.
      if (!get().groups.some((g) => g.id === group.id)) applyGroups([...get().groups, group]);
      if (projectId) {
        await withRetry("Couldn't move project", () =>
          projectGroupsClient.setMembership(projectId, group.id)
        );
      }
      return group;
    },

    renameGroup: async (groupId, name) => {
      applyGroups(await projectGroupsClient.rename(groupId, name));
    },

    deleteGroup: (groupId) =>
      withRetry("Couldn't delete group", async () => {
        applyGroups(await projectGroupsClient.delete(groupId));
      }),

    moveGroup: (groupId, delta) =>
      // The order is worked out inside each attempt, from the list as it is
      // then: a retry after another window added a group must send the new
      // whole order, not repeat the one the host already refused.
      withRetry("Couldn't move group", async () => {
        const ids = get().groups.map((g) => g.id);
        const from = ids.indexOf(groupId);
        const to = from + delta;
        if (from === -1 || to < 0 || to >= ids.length) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]!);
        applyGroups(await projectGroupsClient.reorder(ids));
      }),

    setGroupSortMode: (groupId, sortMode) =>
      withRetry("Couldn't change sort order", async () => {
        applyGroups(await projectGroupsClient.setSortMode(groupId, sortMode));
      }),

    setProjectGroup: (projectId, groupId) =>
      withRetry("Couldn't move project", () =>
        projectGroupsClient.setMembership(projectId, groupId)
      ),

    setProjectArchived: (projectId, archived) =>
      withRetry(archived ? "Couldn't archive project" : "Couldn't unarchive project", () =>
        projectGroupsClient.setArchived(projectId, archived)
      ),
  };
});
