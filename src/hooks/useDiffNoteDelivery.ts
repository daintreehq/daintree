import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore, usePreferencesStore } from "@/store";
import { isPtyPanel } from "@shared/types/panel";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import { isPathInside, join } from "@shared/utils/path";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { terminalClient } from "@/clients";
import { formatForTerminalPaste } from "@shared/utils/terminalInputProtocol";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import {
  formatDiffNotesPrompt,
  sortDiffNotes,
  type DiffNote,
} from "@/components/Worktree/diffNotes";

export interface DiffNoteTarget {
  id: string;
  title: string;
  isInputLocked: boolean;
}

/**
 * A paste is only safe into an agent: in a plain shell each line of a
 * multi-line note would run as a command. `isAgent` is the observed identity
 * (detected, or the launch agent until an exit was seen), so a pane whose agent
 * quit back to its shell drops out.
 */
function isAgentPasteTarget(panel: PanelInstance | undefined): panel is PtyPanelData {
  if (!panel) return false;
  if (
    panel.location === "trash" ||
    panel.location === "background" ||
    panel.location === "overlay"
  ) {
    return false;
  }
  if (!isPtyPanel(panel) || panel.hasPty === false) return false;
  return deriveTerminalChrome(panel).isAgent;
}

export function useDiffNoteTargets(): DiffNoteTarget[] {
  const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);
  const panels = usePanelStore(
    useShallow((state) =>
      state.panelIds
        .map((id) => state.panelsById[id])
        .filter((panel): panel is PtyPanelData => isAgentPasteTarget(panel))
    )
  );
  return useMemo(
    () =>
      panels.map((panel) => ({
        id: panel.id,
        title: getTerminalDisplayTitle(panel, "full", { showTask: showAgentTaskTitles }),
        isInputLocked: panel.isInputLocked === true,
      })),
    [panels, showAgentTaskTitles]
  );
}

export type DiffNoteDeliveryResult =
  { ok: true; sent: number; kept: number; targetTitle: string } | { ok: false; message: string };

/**
 * Pastes the notes into an agent pane and clears the ones that went. Never
 * presses Enter — the reviewer reads the prompt in the agent's composer and
 * submits it themselves. The target is re-checked at send time because the
 * picker's list can be a frame behind a pane closing or its agent exiting.
 */
export function deliverDiffNotes(
  targetId: string,
  notes: readonly DiffNote[]
): DiffNoteDeliveryResult {
  if (notes.length === 0) return { ok: false, message: "There are no notes to send." };
  const panel = usePanelStore.getState().panelsById[targetId];
  if (!isAgentPasteTarget(panel)) {
    return { ok: false, message: "That agent is no longer running." };
  }
  if (panel.isInputLocked) {
    return { ok: false, message: "That agent's input is locked." };
  }

  // Without bracketed paste every newline in the prompt reaches the agent as
  // Enter, which would submit it a line at a time. A pane with no mounted
  // instance has no mode to read; the palette treats that as wrapped, and so
  // does this.
  const managed = terminalInstanceService.get(targetId);
  if (managed && !managed.terminal.modes.bracketedPasteMode) {
    return { ok: false, message: "That agent isn't accepting pasted text right now." };
  }

  // A note whose editor is open is mid-edit: sending the old text and then
  // clearing it would throw the rewrite away, so it waits for the next send.
  const { editingIds } = useDiffNotesStore.getState();
  const ordered = sortDiffNotes(notes.filter((note) => !editingIds[note.id]));
  if (ordered.length === 0) {
    return { ok: false, message: "Finish editing your notes before sending them." };
  }
  // Paths stay worktree-relative for an agent working in that worktree; any
  // other agent would resolve them against its own checkout, so it gets them
  // absolute.
  const cwd = panel.cwd;
  const prompt = formatDiffNotesPrompt(ordered, (note) =>
    cwd && isPathInside(cwd, note.worktreePath)
      ? note.filePath
      : join(note.worktreePath, note.filePath)
  );
  try {
    terminalClient.write(targetId, formatForTerminalPaste(prompt, { bracketedPasteMode: true }));
  } catch (error) {
    return { ok: false, message: formatErrorMessage(error, "The paste couldn't be written.") };
  }
  if (managed) terminalInstanceService.notifyUserInput(targetId);

  const sent = useDiffNotesStore.getState().clearSent(ordered);
  return {
    ok: true,
    sent,
    kept: notes.length - sent,
    targetTitle: getTerminalDisplayTitle(panel, "base"),
  };
}
