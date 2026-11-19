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
 * Main's revisions order everything: a list reply and pushes can arrive in
 * either order, over a Remote Host link too.
 */
interface CodexLimitContinueStoreState {
  panes: Readonly<Record<string, ArmedPane>>;
  /** The revision each pane was disarmed at, so an older arm arriving later changes nothing. */
  disarmed: Readonly<Record<string, number>>;
  applyChange: (change: CodexLimitContinueChange) => void;
  /**
   * Main's list, merged by revision. A pane missing from it is dropped unless
   * a push named it after the list was asked for (`pushedSince`).
   */
  mergeSnapshot: (
    entries: readonly CodexLimitContinueEntry[],
    pushedSince: ReadonlySet<string>
  ) => void;
}

export const useCodexLimitContinueStore = create<CodexLimitContinueStoreState>((set) => ({
  panes: {},
  disarmed: {},
  applyChange: ({ terminalId, revision, state }) =>
    set((current) => {
      const floor = Math.max(
        current.panes[terminalId]?.revision ?? 0,
        current.disarmed[terminalId] ?? 0
      );
      if (revision <= floor) return current;
      if (state === null) {
        const { [terminalId]: _dropped, ...rest } = current.panes;
        return { panes: rest, disarmed: { ...current.disarmed, [terminalId]: revision } };
      }
      return { panes: { ...current.panes, [terminalId]: { revision, state } } };
    }),
  mergeSnapshot: (entries, pushedSince) =>
    set((current) => {
      const panes: Record<string, ArmedPane> = {};
      for (const { terminalId, revision, state } of entries) {
        if ((current.disarmed[terminalId] ?? 0) >= revision) continue;
        const held = current.panes[terminalId];
        panes[terminalId] = held && held.revision > revision ? held : { revision, state };
      }
      for (const [terminalId, held] of Object.entries(current.panes)) {
        if (!(terminalId in panes) && pushedSince.has(terminalId)) panes[terminalId] = held;
      }
      return { panes };
    }),
}));

/** Whether main holds `terminalId` armed, as this view last heard. */
export function isArmedToContinue(terminalId: string): boolean {
  return terminalId in useCodexLimitContinueStore.getState().panes;
}
