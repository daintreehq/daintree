export const workspaceResidencyClient = {
  get: (workspaceId: string): Promise<boolean> => {
    return window.electron.workspaceResidency.get({ workspaceId });
  },

  set: (workspaceId: string, keepResident: boolean): Promise<void> => {
    return window.electron.workspaceResidency.set({ workspaceId, keepResident });
  },
};
