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
  /**
   * One of this machine's own pages is shown while another machine is picked.
   * Every pick, from wherever, goes back to that machine's work settings.
   */
  showingDevicePage: boolean;
  setHostId: (hostId: HostId | null) => void;
  setShowingDevicePage: (showing: boolean) => void;
}

export const useSettingsTargetStore = create<SettingsTargetState>((set) => ({
  hostId: null,
  showingDevicePage: false,
  setHostId: (hostId) => set({ hostId, showingDevicePage: false }),
  setShowingDevicePage: (showingDevicePage) => set({ showingDevicePage }),
}));
