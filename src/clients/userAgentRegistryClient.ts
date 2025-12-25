import type { UserAgentRegistry, UserAgentConfig } from "@shared/types";

export const userAgentRegistryClient = {
  get: (): Promise<UserAgentRegistry> => {
    return window.electron.userAgentRegistry.get();
  },

  add: (config: UserAgentConfig): Promise<{ success: boolean; error?: string }> => {
    return window.electron.userAgentRegistry.add(config);
  },

  update: (
    id: string,
    config: UserAgentConfig
  ): Promise<{ success: boolean; error?: string }> => {
    return window.electron.userAgentRegistry.update(id, config);
  },

  remove: (id: string): Promise<{ success: boolean; error?: string }> => {
    return window.electron.userAgentRegistry.remove(id);
  },
} as const;
