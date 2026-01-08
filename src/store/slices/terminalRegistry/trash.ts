import type { TerminalRegistryStoreApi } from "./types";

export interface TrashExpiryHelpers {
  clearTrashExpiryTimer: (id: string) => void;
  scheduleTrashExpiry: (id: string, expiresAt: number) => void;
}

export const createTrashExpiryHelpers = (
  get: TerminalRegistryStoreApi["getState"],
  set: TerminalRegistryStoreApi["setState"]
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

      const terminal = state.terminals.find((t) => t.id === id);
      if (terminal?.location === "trash") {
        state.removeTerminal(id);
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

  return { clearTrashExpiryTimer, scheduleTrashExpiry };
};
