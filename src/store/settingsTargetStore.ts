import { create } from "zustand";
import type { HostId } from "@shared/types/remoteHosts";

/**
 * The machine Settings edits work settings on, when it isn't the one this
 * window works on (#14706): a paired host, or `local` (this machine) from a
 * window attached to a host. Null is the window's own machine, edited through
 * its ordinary pages. Never changes what the window is attached to.
 */
interface SettingsTargetState {
  hostId: HostId | null;
  setHostId: (hostId: HostId | null) => void;
}

export const useSettingsTargetStore = create<SettingsTargetState>((set) => ({
  hostId: null,
  setHostId: (hostId) => set({ hostId }),
}));
