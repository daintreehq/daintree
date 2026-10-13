import { create } from "zustand";
import type { PendingHostSwitch } from "@shared/types/ipc/remoteHosts";

/**
 * This view's window on its way to another host, as main last described it;
 * null while it isn't switching. Until the switch lands the window keeps
 * showing what it shows, so this is the one place that says otherwise: the
 * progress feedback reads it, and so can the host chip.
 */
interface PendingHostSwitchState {
  pending: PendingHostSwitch | null;
  setPending: (pending: PendingHostSwitch | null) => void;
}

export const usePendingHostSwitchStore = create<PendingHostSwitchState>()((set) => ({
  pending: null,
  setPending: (pending) => set({ pending }),
}));
