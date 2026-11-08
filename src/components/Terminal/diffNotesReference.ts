import { usePanelStore } from "@/store/panelStore";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { selectDiffNotes, useDiffNotesStore } from "@/store/diffNotesStore";
import { isPtyPanel } from "@shared/types/panel";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import {
  allocateDiffNotes,
  formatDiffNotesPromptForCwd,
  partitionPendingDiffNotes,
  type DiffNote,
} from "@/components/Worktree/diffNotes";
import type { AtNotesToken, TokenExpansion } from "./hybridInputParsing";

/**
 * A paste is only safe into an agent: in a plain shell each line of a
 * multi-line note would run as a command. `isAgent` is the observed identity
 * (detected, or the launch agent until an exit was seen), so a pane whose agent
 * quit back to its shell drops out.
 */
export function isAgentPasteTarget(panel: PanelInstance | undefined): panel is PtyPanelData {
  if (!panel) return false;
  if (
    panel.location === "trash" ||
    panel.location === "background" ||
    panel.location === "overlay"
  ) {
    return false;
  }
  if (!isPtyPanel(panel) || panel.hasPty === false) return false;
  // Mid-restart the pane keeps its agent identity but its instance is gone
  // and the process is on its way out.
  if (panel.isRestarting) return false;
  return deriveTerminalChrome(panel).isAgent;
}

/** Whether a terminal can still be handed notes: an expansion's awaits can outlast its agent. */
export function isDiffNotesTarget(terminalId: string): boolean {
  return isAgentPasteTarget(usePanelStore.getState().panelsById[terminalId]);
}

/** The agent's own worktree and where it sits; never another worktree's, whatever it's selected on. */
function readNotesSource(terminalId: string): { worktreePath: string; cwd?: string } | null {
  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!isAgentPasteTarget(panel) || !panel.worktreeId) return null;
  const worktree = getCurrentViewStoreOrNull()?.getState().worktrees.get(panel.worktreeId);
  return worktree?.path ? { worktreePath: worktree.path, cwd: panel.cwd } : null;
}

/**
 * `@notes` tokens replaced by the pending notes of the agent's own worktree, as
 * they read now, and handed to `onTaken` for the caller to clear once the text
 * is delivered. Nothing is cleared here. A caller that can't report delivery
 * passes no `onTaken` and takes no notes: they could never leave the outbox.
 */
export function expandDiffNotesTokens(
  tokens: readonly AtNotesToken[],
  terminalId: string,
  onTaken: ((notes: readonly DiffNote[]) => void) | undefined
): TokenExpansion[] {
  if (tokens.length === 0) return [];
  const source = onTaken ? readNotesSource(terminalId) : null;
  if (!onTaken || !source) {
    return tokens.map(({ start, end }) => ({
      start,
      end,
      replacement: "[Diff notes aren't available here]",
    }));
  }

  const state = useDiffNotesStore.getState();
  const pending = partitionPendingDiffNotes(
    selectDiffNotes(state, source.worktreePath),
    state.editingIds
  );
  const allocated = allocateDiffNotes(tokens, pending.sendable);
  const taken = allocated.flat();
  if (taken.length > 0) onTaken(taken);

  return tokens.map((token, index) => {
    const { start, end } = token;
    const notes = allocated[index]!;
    if (notes.length > 0) {
      return {
        start,
        end,
        replacement: formatDiffNotesPromptForCwd(notes, source.cwd),
        block: true,
      };
    }
    const names = (note: DiffNote) => token.filePath === null || note.filePath === token.filePath;
    const scope = token.filePath === null ? "" : ` for ${token.filePath}`;
    let replacement = `[No pending diff notes${scope}]`;
    if (pending.sendable.some(names)) replacement = `[Diff notes${scope} included above]`;
    else if (pending.editing.some(names)) replacement = `[Diff notes${scope} still being edited]`;
    return { start, end, replacement };
  });
}
