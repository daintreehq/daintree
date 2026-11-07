import { createContext, use } from "react";
import { actionService } from "@/services/ActionService";
import { consumePaletteFocusRestoreSuppression } from "@/components/ui/paletteFocusRestore";
import { switchToHost } from "@/components/Hosts/hostSwitching";
import { useCanopyStore } from "@/store/canopyStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import type { CanopyAssistantItem } from "./canopyAssistants";
import type { placeOf } from "./canopyInboxPlace";
import { restoreInItsProject } from "./canopyRestoreElsewhere";
import type { CanopyTrashItem } from "./canopyTrash";
import { openAssistantItem } from "./openAssistantItem";

/** Where a run really is: a host of null is this renderer's own. */
export type CanopyRunPlace = ReturnType<typeof placeOf>;

/** What the inbox asks of its host when the user goes to a run's pane. */
export interface CanopyGoToRun {
  place: CanopyRunPlace;
  /** The run as the inbox lists it: in All hosts, keyed by its host. */
  listedRunId: string;
  /** The window should stay as it is and the run open in a new one. */
  newWindow: boolean;
}

/** The inbox's own state, for a host whose answer settles after it was asked. */
export interface CanopyPanelHold {
  /** The inbox still shows what it showed when asked. */
  stillShows: () => boolean;
  /** Closes the panel, remembering where it stood for the next opening. */
  closeForTerminal: (listedRunId: string) => void;
  /** The terminal just focused takes the keyboard back on close. */
  captureFocusAfterClose: () => void;
}

/**
 * What hosts Canopy's inbox, and what only a host can decide. The dialog in a
 * project view is one; a host with no dialog and no project is the other. No
 * decision has a default, so a new host can't inherit moving a project window
 * it doesn't have. A host keeps one frame for as long as it mounts the inbox.
 */
export interface CanopyFrame {
  host: "dialog" | "standalone";
  /** The workspace around the inbox, null with none. Only the dialog has "This project". */
  workspaceId: () => string | null;
  /** The user put the inbox away: its close button, or Escape. */
  close: () => void;
  goToRun: (run: CanopyGoToRun, panel: CanopyPanelHold) => void;
  /** A trashed run its own project has to bring back. */
  restoreElsewhere: (
    item: CanopyTrashItem,
    place: CanopyRunPlace,
    panel: Pick<CanopyPanelHold, "stillShows" | "closeForTerminal">
  ) => void;
  /** Resolves to why it couldn't, in words, or null once it did. */
  openAssistant: (item: CanopyAssistantItem, mounted: () => boolean) => Promise<string | null>;
}

/** Everything in the surface, header included, whichever host draws it. */
export const CANOPY_SURFACE = '[data-testid="canopy-dialog"], [data-canopy-standalone]';

function goToRunFromDialog(
  { place, listedRunId, newWindow }: CanopyGoToRun,
  panel: CanopyPanelHold
): void {
  if (place.hostId !== null) {
    // Another host's run: the window moves to that host and project (or a
    // new one opens there, or the window already showing it comes
    // forward), and the pane is focused wherever it lands. The panel
    // stays open on a switch that didn't happen; its toast says why, and
    // its Retry closes the panel once it lands.
    const focusIntent = { intent: "focus-panel", panelId: place.runId } as const;
    void switchToHost(place.hostId, newWindow, place.workspaceId, {
      focusIntent,
      onLanded: () => {
        // A panel since closed, or showing another host, is the user's newer choice.
        if (panel.stillShows()) panel.closeForTerminal(listedRunId);
      },
    });
    return;
  }
  const args = { runId: place.runId, workspaceId: place.workspaceId };
  if (place.workspaceId !== getViewWorkspaceId()) {
    // The switch replaces this view, so the panel closes first; the view
    // is kept, and the panel opens where it was left when it comes back.
    panel.closeForTerminal(listedRunId);
    void actionService.dispatch("pilot.openRun", args, { source: "user" });
    return;
  }
  // Here already: focus the terminal while the panel is still open, and
  // close only once that worked. `pilot.openRun` arms the palette's
  // focus-restore suppression on success, so the close can't hand focus
  // back to whatever opened the panel.
  void actionService.dispatch("pilot.openRun", args, { source: "user" }).then((result) => {
    if (!result.ok) return;
    // `pilot.openRun` arms the palettes' one-shot restore suppression; this
    // is a dialog, which hands focus on by its own target instead, so the
    // flag is taken here rather than left for the next palette to close.
    consumePaletteFocusRestoreSuppression();
    panel.captureFocusAfterClose();
    panel.closeForTerminal(listedRunId);
  });
}

const closeDialog = () => useCanopyStore.getState().close();

export const CANOPY_DIALOG_FRAME: CanopyFrame = {
  host: "dialog",
  workspaceId: getViewWorkspaceId,
  close: closeDialog,
  goToRun: goToRunFromDialog,
  restoreElsewhere: restoreInItsProject,
  openAssistant: async (item, mounted) => {
    const refused = await openAssistantItem(item);
    if (refused === null && mounted()) closeDialog();
    return refused;
  },
};

/** A host with no dialog and no project: it decides the rest. */
export function standaloneCanopyFrame(
  decisions: Omit<CanopyFrame, "host" | "workspaceId">
): CanopyFrame {
  return { ...decisions, host: "standalone", workspaceId: () => null };
}

export const CanopyFrameContext = createContext<CanopyFrame>(CANOPY_DIALOG_FRAME);

export function useCanopyFrame(): CanopyFrame {
  return use(CanopyFrameContext);
}
