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
  /** False when the view already holds something at least as new. */
  applyChange: (change: CodexLimitContinueChange) => boolean;
  /**
   * Main's list, merged by revision. A pane missing from it is dropped unless
   * a push applied after the list was asked for named it (`pushedSince`). The
   * list was read after every push before it, so it supersedes their disarm
   * marks: a host restarted since, whose clock may run behind, is believed.
   */
  mergeSnapshot: (
    entries: readonly CodexLimitContinueEntry[],
    pushedSince: ReadonlySet<string>
  ) => void;
}

export const useCodexLimitContinueStore = create<CodexLimitContinueStoreState>((set, get) => ({
  panes: {},
  disarmed: {},
  applyChange: ({ terminalId, revision, state }) => {
    const current = get();
    const floor = Math.max(
      current.panes[terminalId]?.revision ?? 0,
      current.disarmed[terminalId] ?? 0
    );
    if (revision <= floor) return false;
    if (state === null) {
      const { [terminalId]: _dropped, ...rest } = current.panes;
      set({ panes: rest, disarmed: { ...current.disarmed, [terminalId]: revision } });
      return true;
    }
    set({ panes: { ...current.panes, [terminalId]: { revision, state } } });
    return true;
  },
  mergeSnapshot: (entries, pushedSince) =>
    set((current) => {
      const panes: Record<string, ArmedPane> = {};
      const disarmed: Record<string, number> = {};
      for (const [terminalId, revision] of Object.entries(current.disarmed)) {
        if (pushedSince.has(terminalId)) disarmed[terminalId] = revision;
      }
      for (const { terminalId, revision, state } of entries) {
        if ((disarmed[terminalId] ?? 0) >= revision) continue;
        const held = pushedSince.has(terminalId) ? current.panes[terminalId] : undefined;
        panes[terminalId] = held && held.revision > revision ? held : { revision, state };
      }
      for (const [terminalId, held] of Object.entries(current.panes)) {
        if (!(terminalId in panes) && pushedSince.has(terminalId)) panes[terminalId] = held;
      }
      return { panes, disarmed };
    }),
}));

/** Whether main holds `terminalId` armed, as this view last heard. */
export function isArmedToContinue(terminalId: string): boolean {
  return terminalId in useCodexLimitContinueStore.getState().panes;
}
