import type { AppState, HydrateResult } from "@shared/types";
import type { AppVersionInfo } from "@shared/types/ipc/app";

/**
 * @example
 * const state = await appClient.getState();
 * await appClient.setState({ sidebarWidth: 400 });
 */
export const appClient = {
  getState: (): Promise<AppState> => {
    return window.electron.app.getState();
  },

  setState: (partialState: Partial<AppState>): Promise<void> => {
    return window.electron.app.setState(partialState);
  },

  getVersion: (): Promise<string> => {
    return window.electron.app.getVersion();
  },

  getVersionInfo: (): Promise<AppVersionInfo> => {
    return window.electron.app.getVersionInfo();
  },

  hydrate: (): Promise<HydrateResult> => {
    return window.electron.app.hydrate();
  },

  quit: (): Promise<void> => {
    return window.electron.app.quit();
  },

  forceQuit: (): Promise<void> => {
    return window.electron.app.forceQuit();
  },
} as const;
