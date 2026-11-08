import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePanelStore } from "@/store/panelStore";
import { selectDiffNotes, useDiffNotesStore } from "@/store/diffNotesStore";
import { partitionPendingDiffNotes, type PendingDiffNotes } from "@/components/Worktree/diffNotes";
import { isAgentPasteTarget } from "../diffNotesReference";

/**
 * The pending notes a composer's `@notes` would take, or `null` where it can't
 * take any: a composer that can't report delivery, a shell, or an agent outside
 * any worktree.
 */
export function useComposerDiffNotes(
  terminalId: string,
  worktreePath: string | undefined,
  enabled: boolean
): PendingDiffNotes | null {
  const isTarget = usePanelStore(
    (state) => enabled && isAgentPasteTarget(state.panelsById[terminalId])
  );
  const path = isTarget && worktreePath ? worktreePath : "";
  const notes = useDiffNotesStore(useShallow((state) => selectDiffNotes(state, path)));
  const editingIds = useDiffNotesStore((state) => state.editingIds);
  return useMemo(
    () => (path ? partitionPendingDiffNotes(notes, editingIds) : null),
    [path, notes, editingIds]
  );
}
