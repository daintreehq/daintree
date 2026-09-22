import type { KeepAwakeConfig, KeepAwakeState } from "@shared/types";

export const keepAwakeClient = {
  getState: (): Promise<KeepAwakeState> => {
    return window.electron.keepAwake.getState();
  },

  updateConfig: (config: Partial<KeepAwakeConfig>): Promise<KeepAwakeState> => {
    return window.electron.keepAwake.updateConfig(config);
  },

  onStateChanged: (callback: (state: KeepAwakeState) => void): (() => void) => {
    return window.electron.keepAwake.onStateChanged(callback);
  },
} as const;
