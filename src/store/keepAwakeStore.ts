import { create } from "zustand";
import type { KeepAwakeState } from "@shared/types";

interface KeepAwakeStoreState {
  /** Main's last reported keep-awake state; null until the first push or read lands. */
  state: KeepAwakeState | null;
  /** Why the last read failed, cleared by the next state that lands. */
  loadError: string | null;
  /**
   * Whether the toolbar shows the indicator. Trails `state.isBlocking` by the
   * Doherty gate on the way up, so a hold shorter than the gate never renders,
   * and drops with it. Owned by `useKeepAwakeSync`.
   */
  visible: boolean;
  /** Applies a state unless a newer one has already landed. */
  applyState: (state: KeepAwakeState) => void;
  setLoadError: (message: string) => void;
  setVisible: (visible: boolean) => void;
}

export const useKeepAwakeStore = create<KeepAwakeStoreState>((set, get) => ({
  state: null,
  loadError: null,
  visible: false,
  applyState: (state) => {
    const current = get().state;
    if (current !== null && state.revision < current.revision) return;
    set({ state, loadError: null });
  },
  setLoadError: (message) => set({ loadError: message }),
  setVisible: (visible) => set({ visible }),
}));
