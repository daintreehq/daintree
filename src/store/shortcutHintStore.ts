import { createStore } from "zustand/vanilla";

/** Invocation counts at which a shortcut hint is shown. Encodes the lifetime cap (set size). */
export const HINT_MILESTONES = new Set([1, 2, 3, 10, 20, 30, 50, 75, 100, 150]);
const POINTER_STALE_MS = 2000;

function hoverOneShotKey(actionId: string, count: number): string {
  return `${actionId}@${count}`;
}

export interface ShortcutHintState {
  counts: Record<string, number>;
  hydrated: boolean;
  pointer: { x: number; y: number; ts: number } | null;
  activeHint: { actionId: string; displayCombo: string; x: number; y: number } | null;
  /** Tracks (actionId, count) pairs that have already triggered a hover hint. */
  hintedHover: Set<string>;
}

export interface ShortcutHintActions {
  hydrateCounts(counts: Record<string, number>): void;
  recordPointer(x: number, y: number): void;
  show(actionId: string, displayCombo: string, position?: { x: number; y: number }): boolean;
  hide(): void;
  incrementCount(actionId: string): void;
  /** Returns true if a hover-triggered hint is eligible for this action at its current count. */
  isHoverEligible(actionId: string): boolean;
  /** Marks a hover hint as shown for one-shot gating. */
  markHoverShown(actionId: string): void;
}

export type ShortcutHintStore = ShortcutHintState & ShortcutHintActions;

export const shortcutHintStore = createStore<ShortcutHintStore>((set, get) => ({
  counts: {},
  hydrated: false,
  pointer: null,
  activeHint: null,
  hintedHover: new Set(),

  hydrateCounts(counts: Record<string, number>) {
    set({ counts, hydrated: true });
  },

  recordPointer(x: number, y: number) {
    set({ pointer: { x, y, ts: Date.now() } });
  },

  show(actionId: string, displayCombo: string, position?: { x: number; y: number }): boolean {
    const { counts } = get();

    let x: number;
    let y: number;
    if (position) {
      // Hover path: use explicit position. Caller (hook) handles eligibility.
      x = position.x;
      y = position.y;
    } else {
      // Dispatch path: use pointer tracking with milestone gating.
      const { pointer } = get();
      if (!pointer) return false;
      if (Date.now() - pointer.ts > POINTER_STALE_MS) return false;
      if (!HINT_MILESTONES.has(counts[actionId] ?? 0)) return false;
      x = pointer.x;
      y = pointer.y;
    }

    set({ activeHint: { actionId, displayCombo, x, y } });
    return true;
  },

  hide() {
    set({ activeHint: null });
  },

  incrementCount(actionId: string) {
    const { counts, hintedHover } = get();
    const updated = { ...counts, [actionId]: (counts[actionId] ?? 0) + 1 };
    // Clear hover one-shot entries for this action — the new count level
    // re-enables hover hints for the next milestone.
    const newHintedHover = new Set(hintedHover);
    for (const key of newHintedHover) {
      if (key.startsWith(`${actionId}@`)) {
        newHintedHover.delete(key);
      }
    }
    set({ counts: updated, hintedHover: newHintedHover });
    window.electron?.shortcutHints?.incrementCount(actionId)?.catch(() => {});
  },

  isHoverEligible(actionId: string): boolean {
    const { hydrated, counts, hintedHover } = get();
    if (!hydrated) return false;
    const count = counts[actionId] ?? 0;

    // Count 0 is eligible for pre-use discovery, but still one-shot gated
    // so the same hint doesn't reappear on repeated hovers.
    if (count === 0) return !hintedHover.has(hoverOneShotKey(actionId, 0));

    // Milestone check for non-zero counts
    if (!HINT_MILESTONES.has(count)) return false;
    // One-shot gating: don't re-show at the same count level
    return !hintedHover.has(hoverOneShotKey(actionId, count));
  },

  markHoverShown(actionId: string) {
    const { counts, hintedHover } = get();
    const count = counts[actionId] ?? 0;
    const next = new Set(hintedHover);
    next.add(hoverOneShotKey(actionId, count));
    set({ hintedHover: next });
  },
}));
