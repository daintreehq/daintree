import type { CanopyFrame, CanopyGoToRun } from "@/components/Canopy/canopyFrame";
import { switchToHost } from "@/components/Hosts/hostSwitching";
import { notify } from "@/lib/notify";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

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
 * The Canopy window's answers to what only a host can decide. It holds no
 * project and moves to none: a pane opens in the window that has it, and what
 * needs a project says which one to open.
 */
export const CANOPY_WINDOW_FRAME: CanopyFrame = {
  close: () => safeFireAndForget(window.electron.window.close(), { context: "Closing Canopy" }),
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
  openAssistant: async () => "Open this assistant from its project's Assistant panel.",
  // Open all day beside the agents' own panes: a row left selected moves no PTY.
  takesTerminalSize: "on-use",
};
