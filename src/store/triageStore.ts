import { create } from "zustand";
import type { TriageCard, TriageSnapshot } from "@shared/types/ipc/triage";

/** What the user last did to a run's prompt from the panel, and whether main took it. */
export interface TriageAck {
  /** The prompt it answered — see {@link triagePromptKey}. */
  promptKey: string;
  kind: "answer" | "reply";
  /** The option label, or the reply text. */
  text: string;
  sent: boolean;
}

interface TriageState {
  isOpen: boolean;
  /** Null until main has answered once — distinct from "no cards yet". */
  snapshot: TriageSnapshot | null;
  /**
   * Reply drafts by terminal incarnation. Here rather than in the card because
   * a card remounts whenever its run changes section or goes stale, and a
   * half-typed reply must survive both — and a close and reopen.
   */
  drafts: Record<string, string>;
  /** Answers and replies sent from the panel, by run, until the run's prompt moves on. */
  acks: Record<string, TriageAck>;
  open: () => void;
  close: () => void;
  toggle: () => void;
  applySnapshot: (snapshot: TriageSnapshot) => void;
  setDraft: (key: string, text: string) => void;
  setAck: (
    runId: string,
    update: (current: TriageAck | undefined) => TriageAck | undefined
  ) => void;
}

/** One prompt on one terminal incarnation: stable while it sits unanswered. */
export function triagePromptKey(card: Pick<TriageCard, "spawnedAt" | "revision">): string {
  return `${card.spawnedAt}:${card.revision}`;
}

export function triageDraftKey(runId: string, spawnedAt: number): string {
  return `${runId}:${spawnedAt}`;
}

/**
 * Open state for the triage panel, and the latest cards main pushed.
 *
 * A store for the same reason as `pilotStore`: the panel opens from an action,
 * a keybinding and a toolbar button, and is lazy-mounted only once open. The
 * snapshot is kept across closes so reopening shows the last cards at once,
 * while main rescans in the background.
 */
export const useTriageStore = create<TriageState>((set) => ({
  isOpen: false,
  snapshot: null,
  drafts: {},
  acks: {},
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  applySnapshot: (snapshot) => set({ snapshot }),
  setDraft: (key, text) =>
    set((state) => {
      const drafts = { ...state.drafts };
      if (text === "") delete drafts[key];
      else drafts[key] = text;
      return { drafts };
    }),
  setAck: (runId, update) =>
    set((state) => {
      const next = update(state.acks[runId]);
      const acks = { ...state.acks };
      if (next === undefined) delete acks[runId];
      else acks[runId] = next;
      return { acks };
    }),
}));
