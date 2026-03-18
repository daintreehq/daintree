import { createStore } from "zustand/vanilla";

const MAX_HINT_COUNT = 3;
const POINTER_STALE_MS = 2000;

export interface ShortcutHintState {
  counts: Record<string, number>;
  hydrated: boolean;
  pointer: { x: number; y: number; ts: number } | null;
  activeHint: { actionId: string; displayCombo: string; x: number; y: number } | null;
}

export interface ShortcutHintActions {
  hydrateCounts(counts: Record<string, number>): void;
  recordPointer(x: number, y: number): void;
  show(actionId: string, displayCombo: string): boolean;
  hide(): void;
  incrementCount(actionId: string): void;
}

export type ShortcutHintStore = ShortcutHintState & ShortcutHintActions;

export const shortcutHintStore = createStore<ShortcutHintStore>((set, get) => ({
  counts: {},
  hydrated: false,
  pointer: null,
  activeHint: null,

  hydrateCounts(counts: Record<string, number>) {
    set({ counts, hydrated: true });
  },

  recordPointer(x: number, y: number) {
    set({ pointer: { x, y, ts: Date.now() } });
  },

  show(actionId: string, displayCombo: string): boolean {
    const { pointer, counts } = get();
    if (!pointer) return false;
    if (Date.now() - pointer.ts > POINTER_STALE_MS) return false;
    if ((counts[actionId] ?? 0) >= MAX_HINT_COUNT) return false;

    set({ activeHint: { actionId, displayCombo, x: pointer.x, y: pointer.y } });
    return true;
  },

  hide() {
    set({ activeHint: null });
  },

  incrementCount(actionId: string) {
    const { counts } = get();
    const updated = { ...counts, [actionId]: (counts[actionId] ?? 0) + 1 };
    set({ counts: updated });
    window.electron?.shortcutHints?.incrementCount(actionId)?.catch(() => {});
  },
}));
