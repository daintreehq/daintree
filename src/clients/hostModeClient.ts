import type { HostModeEvent, HostModeStatus, SetHostModePayload } from "@shared/types/ipc/hostMode";

/** This machine as a host. Always answered by this machine, whichever host a window shows. */
export const hostModeClient = {
  getStatus: (): Promise<HostModeStatus> => {
    return window.electron.hostMode.getStatus();
  },

  setEnabled: (payload: SetHostModePayload): Promise<HostModeStatus> => {
    return window.electron.hostMode.setEnabled(payload);
  },

  runKeychainPreflight: (): Promise<HostModeStatus> => {
    return window.electron.hostMode.runKeychainPreflight();
  },

  onEvent: (callback: (event: HostModeEvent) => void): (() => void) => {
    return window.electron.hostMode.onEvent(callback);
  },
} as const;
