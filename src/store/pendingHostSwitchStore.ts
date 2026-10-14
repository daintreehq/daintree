import { create } from "zustand";
import type { PendingHostSwitch } from "@shared/types/ipc/remoteHosts";
import { setSwitchInputBlock } from "@/services/terminal/inputGate";

/**
 * This view's window on its way to another host, as main last described it;
 * null while it isn't switching. Until the switch lands the window keeps
 * showing what it shows, so this is the one place that says otherwise: the
 * progress feedback reads it, and so can the host chip. Typing goes nowhere
 * for as long as it is set.
 */
interface PendingHostSwitchState {
  pending: PendingHostSwitch | null;
  setPending: (pending: PendingHostSwitch | null) => void;
}

export const usePendingHostSwitchStore = create<PendingHostSwitchState>()((set) => ({
  pending: null,
  setPending: (pending) => {
    // Blocked from the first moment, not from when progress shows: keystrokes
    // typed into a fast switch would land in the terminal the window is leaving.
    setSwitchInputBlock(pending ? { kind: "switching", hostName: pending.hostName } : null);
    set({ pending });
  },
}));
