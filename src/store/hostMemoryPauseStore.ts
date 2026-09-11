import { create } from "zustand";
import type { HostMemoryPauseSnapshot } from "@shared/types/pty-host";

interface HostMemoryPauseState {
  /** Main's last reported snapshot; null until the first push or pull lands. */
  snapshot: HostMemoryPauseSnapshot | null;
  /**
   * Whether the toolbar shows the pause. Trails `snapshot.active` by the Doherty
   * gate on the way up, so a pause shorter than the gate never renders, and
   * drops with it. Owned by `useHostMemoryPauseSync`.
   */
  visible: boolean;
  setSnapshot: (snapshot: HostMemoryPauseSnapshot) => void;
  setVisible: (visible: boolean) => void;
}

export const useHostMemoryPauseStore = create<HostMemoryPauseState>((set) => ({
  snapshot: null,
  visible: false,
  setSnapshot: (snapshot) => set({ snapshot }),
  setVisible: (visible) => set({ visible }),
}));
