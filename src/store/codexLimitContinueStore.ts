import { create } from "zustand";
import type {
  CodexLimitContinueChange,
  CodexLimitContinueEntry,
  CodexLimitContinueState,
} from "@shared/types/codexLimitContinuation";

interface ArmedPane {
  revision: number;
  state: CodexLimitContinueState;
}

/**
 * This view's mirror of main's armed Codex panes and where each continuation
 * stands (#17909). Main holds the only record, in memory, so a reloaded view
 * reads it again and shows a pane as armed only while main still says so.
 */
interface CodexLimitContinueStoreState {
  panes: Readonly<Record<string, ArmedPane>>;
  applyChange: (change: CodexLimitContinueChange) => void;
  replaceAll: (entries: readonly CodexLimitContinueEntry[]) => void;
}

export const useCodexLimitContinueStore = create<CodexLimitContinueStoreState>((set) => ({
  panes: {},
  applyChange: ({ terminalId, revision, state }) =>
    set((current) => {
      const known = current.panes[terminalId];
      if (known && known.revision >= revision) return current;
      if (state === null) {
        if (!known) return current;
        const { [terminalId]: _dropped, ...rest } = current.panes;
        return { panes: rest };
      }
      return { panes: { ...current.panes, [terminalId]: { revision, state } } };
    }),
  replaceAll: (entries) =>
    set({
      panes: Object.fromEntries(
        entries.map(({ terminalId, revision, state }) => [terminalId, { revision, state }])
      ),
    }),
}));

/** Whether main holds `terminalId` armed, as this view last heard. */
export function isArmedToContinue(terminalId: string): boolean {
  return terminalId in useCodexLimitContinueStore.getState().panes;
}
