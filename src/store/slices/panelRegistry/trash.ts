import { TRASH_TTL_MS } from "@shared/config/trash";
import type { PanelRegistryStoreApi } from "./types";

/**
 * Renderer-side trash TTL. An unpackaged E2E launch can shorten it; the preload
 * exposes the validated override because the sandboxed renderer cannot read
 * `process.env`. The pty-host applies the same override to its own timer.
 */
export function getTrashTtlMs(): number {
  if (typeof window === "undefined") return TRASH_TTL_MS;
  const override: unknown = Reflect.get(window, "__DAINTREE_E2E_TRASH_TTL_MS__");
  return typeof override === "number" && Number.isFinite(override) && override > 0
    ? override
    : TRASH_TTL_MS;
}

export interface TrashExpiryHelpers {
  clearTrashExpiryTimer: (id: string) => void;
  scheduleTrashExpiry: (id: string, expiresAt: number) => void;
  cleanupTrashExpiryListeners: () => void;
}

export const createTrashExpiryHelpers = (
  get: PanelRegistryStoreApi["getState"],
  set: PanelRegistryStoreApi["setState"]
): TrashExpiryHelpers => {
  const trashExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const clearTrashExpiryTimer = (id: string) => {
    const timer = trashExpiryTimers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    trashExpiryTimers.delete(id);
  };

  const scheduleTrashExpiry = (id: string, expiresAt: number) => {
    clearTrashExpiryTimer(id);
    const delay = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(() => {
      clearTrashExpiryTimer(id);
      const state = get();
      const trashedInfo = state.trashedTerminals.get(id);
      if (!trashedInfo || trashedInfo.expiresAt !== expiresAt) return;

      const terminal = state.panelsById[id];
      if (terminal?.location === "trash") {
        state.removePanel(id);
      } else if (!terminal) {
        set((state) => {
          if (!state.trashedTerminals.has(id)) return state;
          const newTrashed = new Map(state.trashedTerminals);
          newTrashed.delete(id);
          return { trashedTerminals: newTrashed };
        });
      }
    }, delay);
    trashExpiryTimers.set(id, timer);
  };

  // Sweep expired trash entries on visibility restore. Chromium's
  // IntensiveWakeUpThrottling coalesces setTimeout wake-ups to max 1/minute
  // when the document is hidden, so the 20s trash TTL timer can fire 30-60s
  // late. On visibility restore, immediately remove any entry whose wall-clock
  // expiry has passed.
  const sweepExpiredTrash = () => {
    const state = get();
    const now = Date.now();
    for (const [id, trashedInfo] of Array.from(state.trashedTerminals.entries())) {
      if (trashedInfo.expiresAt > now) continue;
      const terminal = state.panelsById[id];
      try {
        if (terminal?.location === "trash") {
          state.removePanel(id);
        } else {
          // Terminal either doesn't exist or isn't in trash — the trash
          // metadata is stale/corrupted. Clean it up without touching
          // the terminal itself.
          set((state) => {
            if (!state.trashedTerminals.has(id)) return state;
            const newTrashed = new Map(state.trashedTerminals);
            newTrashed.delete(id);
            return { trashedTerminals: newTrashed };
          });
        }
      } catch {
        // Abort this entry but continue sweeping remaining entries.
      }
    }
  };

  const handleVisibilityChange = () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState !== "visible") return;
    sweepExpiredTrash();
  };

  let visibilityListenerAttached = false;
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    visibilityListenerAttached = true;
  }

  const cleanupTrashExpiryListeners = () => {
    if (visibilityListenerAttached) {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      visibilityListenerAttached = false;
    }
  };

  return { clearTrashExpiryTimer, scheduleTrashExpiry, cleanupTrashExpiryListeners };
};
