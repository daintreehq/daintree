import { create } from "zustand";
import type { Scratch } from "@shared/types";
// Import the client directly (not via the @/clients barrel) so tests that
// mock the barrel — without listing scratchClient — don't crash on access.
// The barrel is mocked in many test setups; importing from the leaf module
// keeps this store decoupled from those mocks.
import { scratchClient } from "@/clients/scratchClient";
import { getViewWorkspaceId } from "./viewWorkspaceId";
import { logError } from "@/utils/logger";

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
  switchScratch: (
    scratchId: string,
    options?: { focusIntent?: import("@shared/types/ipc/project").ProjectFocusOnActivateIntent }
  ) => Promise<void>;
  removeScratch: (scratchId: string) => Promise<void>;
  renameScratch: (scratchId: string, name: string) => Promise<void>;
  setCurrentScratch: (scratch: Scratch | null) => void;
  upsertScratch: (scratch: Scratch) => void;
  removeScratchLocal: (scratchId: string) => void;
}

/**
 * The load in flight, so a concurrent caller can await the SAME work instead of
 * being told "already loading" and resolving against an empty store.
 *
 * Boot hydration starts a fire-and-forget load; the switcher then awaits its own
 * `loadScratches()` before reading ids for the agent-status pull. Returning a
 * bare resolved promise there let the palette read zero scratches and omit them
 * from that pull, leaving their rows on the opened-time fallback until some
 * later transition happened to re-broadcast (#11518).
 */
let scratchLoadInFlight: Promise<void> | null = null;

export const useScratchStore = create<ScratchStoreState>((set, get) => ({
  scratches: [],
  currentScratch: null,
  isLoading: false,

  loadScratches: () => {
    if (scratchLoadInFlight) return scratchLoadInFlight;
    set({ isLoading: true });
    scratchLoadInFlight = (async () => {
      try {
        const [scratches, current] = await Promise.all([
          scratchClient.getAll(),
          scratchClient.getCurrent(),
        ]);
        set({ scratches, currentScratch: current });
      } finally {
        set({ isLoading: false });
        scratchLoadInFlight = null;
      }
    })();
    return scratchLoadInFlight;
  },

  createScratch: async (name?: string) => {
    const scratch = await scratchClient.create(name);
    // Dedup: the main process broadcasts a SCRATCH_UPDATED push BEFORE the
    // invoke response arrives, so `upsertScratch` may have already inserted
    // this scratch. Use upsert here too instead of a blind prepend.
    get().upsertScratch(scratch);
    return scratch;
  },

  switchScratch: async (scratchId: string, options) => {
    const switched = await scratchClient.switch(scratchId, options);
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

/**
 * Deleting a scratch must leave the app in an empty state, not a grid of dead
 * agent panels: the exit listener deliberately *preserves* agent terminals after
 * their PTY exits (so a finished agent stays reviewable), so killing the PTYs is
 * not enough — nothing else ever removes the panels (#11079). `removePanel` also
 * kills each PTY by id, which backstops any terminal the workspace-scoped kill in
 * `scratch:remove` missed.
 *
 * Keyed on the view's own workspace id, never on `currentScratch`: the removal is
 * broadcast to *every* view (cached ones included) and `currentScratch` is
 * replicated into all of them, so matching on it would wipe a sibling project
 * view's live panels.
 */
async function closePanelsForRemovedScratch(scratchId: string): Promise<void> {
  if (!scratchId || getViewWorkspaceId() !== scratchId) return;

  const { usePanelStore } = await import("@/store/panelStore");
  const state = usePanelStore.getState();
  for (const panelId of [...state.panelIds]) {
    state.removePanel(panelId);
  }
}

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
      void closePanelsForRemovedScratch(scratchId).catch((error: unknown) => {
        logError("[ScratchStore] Failed to close panels for removed scratch", error);
      });
    });
    window.electron.scratch.onSwitch((payload) => {
      if (!payload) return;
      // payload.scratch is null when a project switch deactivated the
      // previously-active scratch. Clear local current state in that case.
      useScratchStore.getState().setCurrentScratch(payload.scratch);
    });
  }
}
