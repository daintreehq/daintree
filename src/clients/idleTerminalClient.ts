import type { IdleTerminalNotifyConfig, IdleTerminalNotifyPayload } from "@shared/types";
import type { PluginWorkStopped } from "@shared/types/ipc/project";

export const idleTerminalClient = {
  getConfig: (): Promise<IdleTerminalNotifyConfig> => {
    return window.electron.idleTerminals.getConfig();
  },

  updateConfig: (config: Partial<IdleTerminalNotifyConfig>): Promise<IdleTerminalNotifyConfig> => {
    return window.electron.idleTerminals.updateConfig(config);
  },

  /** Resolves to the plugin work the sleep stopped, or null when it stopped none. */
  closeProject: (projectId: string): Promise<PluginWorkStopped | null> => {
    return window.electron.idleTerminals.closeProject(projectId);
  },

  dismissProject: (projectId: string): Promise<void> => {
    return window.electron.idleTerminals.dismissProject(projectId);
  },

  onNotify: (callback: (payload: IdleTerminalNotifyPayload) => void): (() => void) => {
    return window.electron.idleTerminals.onNotify(callback);
  },
} as const;
