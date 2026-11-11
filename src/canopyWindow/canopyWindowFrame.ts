import type { CanopyAssistantItem } from "@/components/Canopy/canopyAssistants";
import type { CanopyFrame, CanopyGoToRun } from "@/components/Canopy/canopyFrame";
import { assistantOpenRefusal } from "@/components/Canopy/openAssistantItem";
import { switchToHost } from "@/components/Hosts/hostSwitching";
import { notify } from "@/lib/notify";
import { openAssistantFromCanopyWindow } from "@/services/assistantSubject";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";

/**
 * A run on this machine: main brings forward the window holding its workspace,
 * activating it there if it is cached, or opens a window on it, and that window
 * focuses the pane. Its failure is told here, since nothing else moved.
 */
function goToLocalRun(workspaceId: string, runId: string): void {
  window.electron.canopyWindow.goToRun({ workspaceId, runId }).catch((error: unknown) => {
    // A workspace that is gone stays gone: trying again can't help.
    const retry =
      clientErrorCode(error) === "NOT_FOUND"
        ? undefined
        : {
            label: "Try again",
            variant: "primary" as const,
            onClick: () => goToLocalRun(workspaceId, runId),
          };
    // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
    notify({
      type: "error",
      title: "Couldn't open agent",
      message: clientErrorText(error, "Its project's window didn't open."),
      context: { eventKind: "agent" },
      duration: 6000,
      ...(retry ? { actions: [retry] } : {}),
    });
  });
}

/**
 * Go to pane from a window with no project of its own (#16337): the run is
 * reached where it lives, and this window stays open on its selection. Another
 * host's run lands in a window on that host, the one already showing its
 * project or a new one, never this one. That switch says itself why it failed,
 * offering only a recovery this window can run.
 */
function goToRun({ place }: CanopyGoToRun): void {
  if (place.hostId === null) {
    goToLocalRun(place.workspaceId, place.runId);
    return;
  }
  void switchToHost(place.hostId, true, place.workspaceId, {
    focusIntent: { intent: "focus-panel", panelId: place.runId },
    standalone: true,
  });
}

/**
 * Open in Assistant from a window with no project of its own (#16758): the
 * assistant opens in a window of the machine it runs on, and this window stays
 * open on its selection. Whatever kept it from opening, a window that didn't
 * come forward included, is said in its pane.
 */
async function openAssistant(item: CanopyAssistantItem): Promise<string | null> {
  try {
    const result = await openAssistantFromCanopyWindow(item.subject);
    if (result.ok) return null;
    // The shared wording says the asking window couldn't move; this one never does.
    return result.reason === "not-switched"
      ? "This assistant runs on another host, and a window there didn't open on it."
      : assistantOpenRefusal(result.reason);
  } catch (error) {
    return clientErrorText(error, "Its window didn't open. Try again.");
  }
}

/**
 * The Canopy window's answers to what only a host can decide. It holds no
 * project and moves to none: a pane opens in the window that has it, and what
 * needs a project says which one to open.
 */
export const CANOPY_WINDOW_FRAME: CanopyFrame = {
  goToRun,
  restoreElsewhere: () => {
    notify({
      type: "info",
      title: "Project isn't open",
      message: "Open the project this terminal ran in, then restore it from Canopy.",
      context: { eventKind: "agent" },
      duration: 6000,
    });
  },
  openAssistant,
  // Open all day beside the agents' own panes: a row left selected moves no PTY.
  takesTerminalSize: "on-use",
};
