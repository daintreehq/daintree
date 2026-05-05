import { create } from "zustand";
import type { Scratch } from "@shared/types";
import { scratchClient } from "@/clients";

/**
 * Renderer-side Zustand store for Scratch (one-off agent workspace) state.
 * Deliberately minimal: scratches are throwaway, do not need frecency,
 * stats, or persistence middleware. Their lifecycle is short-lived and the
 * source of truth lives in the main process SQLite store.
 */
interface ScratchStoreState {
  scratches: Scratch[];
  currentScratch: Scratch | null;
  isLoading: boolean;
  loadScratches: () => Promise<void>;
  createScratch: (name?: string) => Promise<Scratch>;
  switchScratch: (scratchId: string) => Promise<void>;
  removeScratch: (scratchId: string) => Promise<void>;
  renameScratch: (scratchId: string, name: string) => Promise<void>;
  setCurrentScratch: (scratch: Scratch | null) => void;
  upsertScratch: (scratch: Scratch) => void;
  removeScratchLocal: (scratchId: string) => void;
}

export const useScratchStore = create<ScratchStoreState>((set, get) => ({
  scratches: [],
  currentScratch: null,
  isLoading: false,

  loadScratches: async () => {
    if (get().isLoading) return;
    set({ isLoading: true });
    try {
      const [scratches, current] = await Promise.all([
        scratchClient.getAll(),
        scratchClient.getCurrent(),
      ]);
      set({ scratches, currentScratch: current });
    } finally {
      set({ isLoading: false });
    }
  },

  createScratch: async (name?: string) => {
    const scratch = await scratchClient.create(name);
    // Dedup: the main process broadcasts a SCRATCH_UPDATED push BEFORE the
    // invoke response arrives, so `upsertScratch` may have already inserted
    // this scratch. Use upsert here too instead of a blind prepend.
    get().upsertScratch(scratch);
    return scratch;
  },

  switchScratch: async (scratchId: string) => {
    const switched = await scratchClient.switch(scratchId);
    set((state) => ({
      currentScratch: switched,
      scratches: state.scratches.map((s) => (s.id === switched.id ? switched : s)),
    }));
  },

  removeScratch: async (scratchId: string) => {
    await scratchClient.remove(scratchId);
    set((state) => ({
      scratches: state.scratches.filter((s) => s.id !== scratchId),
      currentScratch: state.currentScratch?.id === scratchId ? null : state.currentScratch,
    }));
  },

  renameScratch: async (scratchId: string, name: string) => {
    const updated = await scratchClient.update(scratchId, { name });
    set((state) => ({
      scratches: state.scratches.map((s) => (s.id === updated.id ? updated : s)),
      currentScratch: state.currentScratch?.id === updated.id ? updated : state.currentScratch,
    }));
  },

  setCurrentScratch: (scratch) => set({ currentScratch: scratch }),

  upsertScratch: (scratch) =>
    set((state) => {
      const idx = state.scratches.findIndex((s) => s.id === scratch.id);
      if (idx === -1) {
        return { scratches: [scratch, ...state.scratches] };
      }
      const next = state.scratches.slice();
      next[idx] = scratch;
      return {
        scratches: next,
        currentScratch: state.currentScratch?.id === scratch.id ? scratch : state.currentScratch,
      };
    }),

  removeScratchLocal: (scratchId) =>
    set((state) => ({
      scratches: state.scratches.filter((s) => s.id !== scratchId),
      currentScratch: state.currentScratch?.id === scratchId ? null : state.currentScratch,
    })),
}));

// HMR-safe: register push-event listeners exactly once. Subsequent module
// reloads in dev hit the early-return so we don't accumulate listeners.
type ListenerState = { registered: boolean };
declare global {
  var __scratchStoreListeners__: ListenerState | undefined;
}

if (typeof window !== "undefined" && window.electron?.scratch) {
  const slot: ListenerState = globalThis.__scratchStoreListeners__ ?? { registered: false };
  globalThis.__scratchStoreListeners__ = slot;

  if (!slot.registered) {
    slot.registered = true;
    window.electron.scratch.onUpdated((scratch) => {
      if (!scratch || typeof scratch !== "object") return;
      useScratchStore.getState().upsertScratch(scratch);
    });
    window.electron.scratch.onRemoved((scratchId) => {
      useScratchStore.getState().removeScratchLocal(scratchId);
    });
    window.electron.scratch.onSwitch((payload) => {
      if (!payload) return;
      // payload.scratch is null when a project switch deactivated the
      // previously-active scratch. Clear local current state in that case.
      useScratchStore.getState().setCurrentScratch(payload.scratch);
    });
  }
}
