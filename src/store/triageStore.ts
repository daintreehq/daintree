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

/** When the user last opened a run in the panel, for its incarnation. */
export interface TriageRead {
  spawnedAt: number;
  at: number;
}

interface TriageState {
  isOpen: boolean;
  /** Null until main has answered once — distinct from "no cards yet". */
  snapshot: TriageSnapshot | null;
  /** Answers and replies sent from the panel, by run, until the run's prompt moves on. */
  acks: Record<string, TriageAck>;
  /**
   * Runs the user has opened, like read mail: unread until opened, and unread
   * again once the screen is read anew after that.
   */
  reads: Record<string, TriageRead>;
  open: () => void;
  close: () => void;
  toggle: () => void;
  applySnapshot: (snapshot: TriageSnapshot) => void;
  setAck: (
    runId: string,
    update: (current: TriageAck | undefined) => TriageAck | undefined
  ) => void;
  markRead: (runId: string, spawnedAt: number, at?: number) => void;
  /** Forget reads for runs no longer running. */
  pruneReads: (live: ReadonlySet<string>) => void;
}

/** One prompt on one terminal incarnation: stable while it sits unanswered. */
export function triagePromptKey(card: Pick<TriageCard, "spawnedAt" | "revision">): string {
  return `${card.spawnedAt}:${card.revision}`;
}

/**
 * Read once the user opened this incarnation after the screen they were shown
 * was read. A card that has not been read off the screen yet is read as soon
 * as the run is opened at all.
 */
export function isTriageRead(
  read: TriageRead | undefined,
  spawnedAt: number,
  card: Pick<TriageCard, "spawnedAt" | "observedAt"> | null
): boolean {
  if (read === undefined || read.spawnedAt !== spawnedAt) return false;
  return card === null || card.spawnedAt !== spawnedAt || card.observedAt <= read.at;
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
  acks: {},
  reads: {},
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  applySnapshot: (snapshot) => set({ snapshot }),
  setAck: (runId, update) =>
    set((state) => {
      const next = update(state.acks[runId]);
      const acks = { ...state.acks };
      if (next === undefined) delete acks[runId];
      else acks[runId] = next;
      return { acks };
    }),
  markRead: (runId, spawnedAt, at = Date.now()) =>
    set((state) => ({ reads: { ...state.reads, [runId]: { spawnedAt, at } } })),
  pruneReads: (live) =>
    set((state) => {
      const departed = Object.keys(state.reads).filter((runId) => !live.has(runId));
      if (departed.length === 0) return state;
      const reads = { ...state.reads };
      for (const runId of departed) delete reads[runId];
      return { reads };
    }),
}));
