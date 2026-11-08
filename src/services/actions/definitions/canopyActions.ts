import type { ActionRegistry } from "../actionTypes";
import { useCanopyStore } from "@/store/canopyStore";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { isCanopyUnread } from "@shared/types/ipc/canopy";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { popOutCanopyDialog } from "@/components/Canopy/canopyPopOut";
import { actionService } from "@/services/ActionService";
import { clientErrorText } from "@/utils/clientAppError";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

const CANOPY_HIDDEN_REASON = "Canopy is hidden. Show it from Settings > Canopy.";

/** Hidden by the user: Canopy has no way in but Settings, for people and agents alike. */
function canopyShown(): boolean {
  return useCanopyStore.getState().mode !== "hidden";
}

const OTHER_HOST_REASON =
  "Canopy is showing another host's agents. Use Mark all read in its panel.";

/**
 * The panel is open on another host: this action reads and marks the window's
 * own host, which is not what the user is looking at.
 */
function showingOtherHost(): boolean {
  const { isOpen, hostId } = useCanopyStore.getState();
  return isOpen && hostId !== null;
}

const AGENTS_UNKNOWN_REASON = "Canopy hasn't listed this project's agents yet.";
const CANOPY_OFF_REASON = "Canopy isn't on. Turn it on from its panel or Settings > Canopy.";

/** Turned on: until then Canopy has read nothing, so nothing is unread. */
function canopyOn(): boolean {
  return useCanopyStore.getState().mode === "on";
}

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

/** The window didn't open, or didn't take the dialog up: whatever was open here still is. */
function notifyWindowFailed(error: unknown): void {
  notify({
    type: "error",
    title: "Couldn't open Canopy window",
    message: clientErrorText(error, "Its window didn't open."),
    context: { eventKind: "agent" },
    duration: 6000,
    actions: [
      {
        label: "Try again",
        variant: "primary",
        onClick: () =>
          safeFireAndForget(
            actionService.dispatch("canopy.openWindow", undefined, { source: "user" })
          ),
      },
    ],
  });
}

/** The canopy panel: every agent, read off its screen and laid out by what it needs. */
export function registerCanopyActions(actions: ActionRegistry): void {
  actions.set("canopy.toggle", () => ({
    id: "canopy.toggle",
    title: "Open Canopy",
    description:
      "Open or close Canopy, the bird's-eye view of every agent across all projects, read off its screen and ordered by what it needs from the user. While Canopy has its own window, brings that window forward",
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
      const { mode, isOpen } = useCanopyStore.getState();
      // Only an on Canopy can have a window, and a panel open here closes as ever.
      if (mode === "on" && !isOpen && (await window.electron.canopyWindow.focus())) return;
      useCanopyStore.getState().toggle();
    },
  }));

  actions.set("canopy.openWindow", () => ({
    id: "canopy.openWindow",
    title: "Open Canopy in new window",
    description:
      "Open Canopy in its own window, with every agent of every project and host, or bring it forward. A panel open here moves into it as it stands",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: canopyOn,
    isEnabled: canopyOn,
    disabledReason: () => (canopyOn() ? undefined : CANOPY_OFF_REASON),
    keywords: ["canopy", "inbox", "agents", "window", "monitor", "detach"],
    selfNotifiesOnExecutionError: true,
    run: async () => {
      // A panel open here moves into the window where it stood, closing once
      // the window has its place: the window shows what it would, and both
      // would size a terminal.
      if (useCanopyStore.getState().isOpen && window.__DAINTREE_CANOPY_WINDOW__ !== true) {
        await popOutCanopyDialog(notifyWindowFailed);
        return;
      }
      try {
        await window.electron.canopyWindow.open();
      } catch (error) {
        notifyWindowFailed(error);
        throw error;
      }
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
    isEnabled: () => canopyOn() && !showingOtherHost() && projectRunsInScope() !== undefined,
    disabledReason: () =>
      !canopyShown()
        ? CANOPY_HIDDEN_REASON
        : !canopyOn()
          ? CANOPY_OFF_REASON
          : showingOtherHost()
            ? OTHER_HOST_REASON
            : projectRunsInScope() === undefined
              ? AGENTS_UNKNOWN_REASON
              : undefined,
    keywords: ["canopy", "inbox", "read", "unread", "clear", "agents"],
    run: async () => {
      if (showingOtherHost()) return;
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
        duration: UNDO_TOAST_DURATION_MS,
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
