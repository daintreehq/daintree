import type { ActionRegistry } from "../actionTypes";
import { canopyOwnHostId, useCanopyStore } from "@/store/canopyStore";
import { isCanopyUnread } from "@shared/types/ipc/canopy";
import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { actionService } from "@/services/ActionService";
import { clientErrorText } from "@/utils/clientAppError";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
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

const CANOPY_OFF_REASON = "Canopy isn't on. Turn it on from its panel or Settings > Canopy.";

/** Turned on: until then Canopy has read nothing, so nothing is unread. */
function canopyOn(): boolean {
  return useCanopyStore.getState().mode === "on";
}

/** The window didn't open. */
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

/**
 * A view on a remote host reads that host's Canopy, while the window is this
 * machine's and opens only while this machine's Canopy is on, which the view
 * can't read. Canopy's inbox opens in no project window (#16581), so such a
 * view has the window or main's word on why not.
 */
function onRemoteHost(): boolean {
  return canopyOwnHostId() !== LOCAL_HOST_ID;
}

/**
 * Whether the window is offered here: once Canopy is on, or in a view on a
 * remote host, wherever it is shown, since only main knows whether this
 * machine's Canopy is on and says so if it isn't.
 */
function windowOffered(): boolean {
  return onRemoteHost() ? canopyShown() : canopyOn();
}

/**
 * Open the one Canopy window, or bring it forward, restored if minimized:
 * Canopy's only home once it is on (#16578), whatever was opened before. An
 * offer this view still holds is put away once the window stands.
 */
async function openCanopyWindow(): Promise<void> {
  try {
    await window.electron.canopyWindow.open();
  } catch (error) {
    notifyWindowFailed(error);
    throw error;
  }
  const { isOpen, close } = useCanopyStore.getState();
  if (isOpen) close();
}

/** The canopy panel: every agent, read off its screen and laid out by what it needs. */
export function registerCanopyActions(actions: ActionRegistry): void {
  actions.set("canopy.toggle", () => ({
    id: "canopy.toggle",
    title: "Open Canopy",
    description:
      "Open Canopy's window, the bird's-eye view of every agent across all projects, read off its screen and ordered by what it needs from the user, or bring it forward. Before Canopy is on, offers to turn it on",
    paletteDescription: "Open Canopy's view of every agent across projects, or offer to turn it on",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: canopyShown,
    isEnabled: canopyShown,
    disabledReason: () => (canopyShown() ? undefined : CANOPY_HIDDEN_REASON),
    keywords: ["canopy", "inbox", "agents", "waiting", "summary", "overview", "fleet"],
    selfNotifiesOnExecutionError: true,
    run: async () => {
      if (onRemoteHost() || useCanopyStore.getState().mode === "on") {
        await openCanopyWindow();
        return;
      }
      // Before Canopy is on there is no window: the offer here asks to turn it on.
      useCanopyStore.getState().toggle();
    },
  }));

  actions.set("canopy.openWindow", () => ({
    id: "canopy.openWindow",
    title: "Open Canopy window",
    description:
      "Open Canopy in its own window, with every agent of every project and host, or bring that window forward, restoring it if minimized",
    paletteDescription: "Open Canopy in its own window, or bring that window forward",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: windowOffered,
    isEnabled: windowOffered,
    disabledReason: () => (windowOffered() ? undefined : CANOPY_OFF_REASON),
    keywords: ["canopy", "inbox", "agents", "window", "monitor", "detach"],
    selfNotifiesOnExecutionError: true,
    run: async () => {
      await openCanopyWindow();
    },
  }));

  actions.set("canopy.markAllRead", () => ({
    id: "canopy.markAllRead",
    title: "Mark all Canopy agents as read",
    description:
      "Mark every agent Canopy lists as unread as read, through what it had done when the panel last showed it; anything an agent does after that stays unread",
    paletteDescription: "Mark every unread agent in Canopy as read",
    category: "project",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    isVisible: canopyShown,
    isEnabled: () => canopyOn() && !showingOtherHost(),
    disabledReason: () =>
      !canopyShown()
        ? CANOPY_HIDDEN_REASON
        : !canopyOn()
          ? CANOPY_OFF_REASON
          : showingOtherHost()
            ? OTHER_HOST_REASON
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
      // The runs the panel would list, as its own Mark all read takes them.
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
