import type { ProjectPresenceSnapshot } from "@shared/types";

export const projectPresenceClient = {
  getSnapshot: (): Promise<ProjectPresenceSnapshot> => {
    return window.electron.projectPresence.getSnapshot();
  },

  onChanged: (callback: () => void): (() => void) => {
    return window.electron.projectPresence.onChanged(callback);
  },
};
