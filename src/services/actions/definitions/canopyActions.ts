import type { ActionRegistry } from "../actionTypes";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { isCanopyUnread } from "@shared/types/ipc/canopy";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

const CANOPY_HIDDEN_REASON = "Canopy is hidden. Show it from Settings > Canopy.";

/** Hidden by the user: Canopy has no way in but Settings, for people and agents alike. */
function canopyShown(): boolean {
  return useCanopyStore.getState().mode !== "hidden";
}

const AGENTS_UNKNOWN_REASON = "Canopy hasn't listed this project's agents yet.";

/**
 * Which runs, by incarnation, are this project's — known only once the fleet
 * has been read, and trusted only while it is current. Null with Canopy set to
 * all projects, where every run counts; undefined while it can't be told.
 */
function projectRunsInScope(): ReadonlySet<string> | null | undefined {
  if (useCanopyStore.getState().scope !== "project") return null;
  const fleet = useFleetSnapshotStore.getState().snapshot;
  if (!fleet || fleet.degraded) return undefined;
  const here = getViewWorkspaceId();
  return new Set(
    fleet.runs
      .filter((run) => run.workspaceId === here)
      .map((run) => `${run.runId}:${run.spawnedAt}`)
  );
}

/** The canopy panel: every agent, read off its screen and laid out by what it needs. */
export function registerCanopyActions(actions: ActionRegistry): void {
  actions.set("canopy.toggle", () => ({
    id: "canopy.toggle",
    title: "Open Canopy",
    description:
      "Open or close Canopy, the bird's-eye view of every agent across all projects, read off its screen and ordered by what it needs from the user",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: canopyShown,
    isEnabled: canopyShown,
    disabledReason: () => (canopyShown() ? undefined : CANOPY_HIDDEN_REASON),
    keywords: ["canopy", "inbox", "agents", "waiting", "summary", "overview", "fleet"],
    run: async () => {
      useCanopyStore.getState().toggle();
    },
  }));

  actions.set("canopy.markAllRead", () => ({
    id: "canopy.markAllRead",
    title: "Mark all Canopy agents as read",
    description:
      "Mark every agent Canopy lists as unread as read — this project's alone when Canopy is set to This project — through what it had done when the panel last showed it; anything an agent does after that stays unread",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: canopyShown,
    isEnabled: () => canopyShown() && projectRunsInScope() !== undefined,
    disabledReason: () =>
      !canopyShown()
        ? CANOPY_HIDDEN_REASON
        : projectRunsInScope() === undefined
          ? AGENTS_UNKNOWN_REASON
          : undefined,
    keywords: ["canopy", "inbox", "read", "unread", "clear", "agents"],
    run: async () => {
      const snapshot = useCanopyStore.getState().snapshot;
      if (!snapshot?.activated) return;
      const archived = new Set(
        snapshot.dispositions
          .filter((entry) => entry.kind === "archived")
          .map((entry) => `${entry.runId}:${entry.spawnedAt}`)
      );
      // The runs the panel would list, as its own Mark all read takes them:
      // with This project chosen, another project's unread stay unread.
      const inScope = projectRunsInScope();
      if (inScope === undefined) return;
      const unread = snapshot.reads.filter(
        (mark) =>
          isCanopyUnread(mark) &&
          !archived.has(`${mark.runId}:${mark.spawnedAt}`) &&
          (inScope === null || inScope.has(`${mark.runId}:${mark.spawnedAt}`))
      );
      if (unread.length === 0) return;
      const after = await window.electron.canopy.markAllRead(
        unread.map(({ runId, spawnedAt, turn }) => ({ runId, spawnedAt, turn }))
      );
      const was = new Map(unread.map((mark) => [mark.runId, mark]));
      // Put back only where nothing has changed since this left it.
      const restores = after.flatMap((left) => {
        const mark = was.get(left.runId);
        return mark !== undefined && mark.spawnedAt === left.spawnedAt
          ? [{ mark, expectVersion: left.version }]
          : [];
      });
      notify({
        type: "success",
        transient: true,
        title: "Marked as read",
        message: pluralize(unread.length, "agent"),
        context: { eventKind: "agent" },
        duration: 6000,
        actions: [
          {
            label: "Undo",
            onClick: () => safeFireAndForget(window.electron.canopy.restoreReads(restores)),
          },
        ],
      });
    },
  }));
}
