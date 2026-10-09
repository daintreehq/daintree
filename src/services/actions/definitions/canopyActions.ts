import type { ActionRegistry } from "../actionTypes";
import { useCanopyStore } from "@/store/canopyStore";
import { isCanopyUnread } from "@shared/types/ipc/canopy";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

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
    keywords: ["canopy", "inbox", "agents", "waiting", "summary", "overview", "fleet"],
    run: async () => {
      useCanopyStore.getState().toggle();
    },
  }));

  actions.set("canopy.markAllRead", () => ({
    id: "canopy.markAllRead",
    title: "Mark all Canopy agents as read",
    description:
      "Mark every agent Canopy shows as unread as read, through what it had done when the panel last showed it; anything an agent does after that stays unread",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    keywords: ["canopy", "inbox", "read", "unread", "clear", "agents"],
    run: async () => {
      const snapshot = useCanopyStore.getState().snapshot;
      if (!snapshot?.activated) return;
      const archived = new Set(
        snapshot.dispositions
          .filter((entry) => entry.kind === "archived")
          .map((entry) => `${entry.runId}:${entry.spawnedAt}`)
      );
      const unread = snapshot.reads.filter(
        (mark) => isCanopyUnread(mark) && !archived.has(`${mark.runId}:${mark.spawnedAt}`)
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
