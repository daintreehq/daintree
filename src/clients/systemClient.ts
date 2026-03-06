/**
 * @example
 * ```typescript
 * import { systemClient } from "@/clients/systemClient";
 *
 * await systemClient.openExternal("https://example.com");
 * const hasGit = await systemClient.checkCommand("git");
 * ```
 */
export const systemClient = {
  openExternal: (url: string): Promise<void> => {
    return window.electron.system.openExternal(url);
  },

  openPath: (path: string): Promise<void> => {
    return window.electron.system.openPath(path);
  },

  openInEditor: (payload: {
    path: string;
    line?: number;
    col?: number;
    projectId?: string;
  }): Promise<void> => {
    return window.electron.system.openInEditor(payload);
  },

  checkCommand: (command: string): Promise<boolean> => {
    return window.electron.system.checkCommand(command);
  },

  checkDirectory: (path: string): Promise<boolean> => {
    return window.electron.system.checkDirectory(path);
  },

  getHomeDir: (): Promise<string> => {
    return window.electron.system.getHomeDir();
  },

  getTmpDir: (): Promise<string> => {
    return window.electron.system.getTmpDir();
  },

  onWake: (
    callback: (data: { sleepDuration: number; timestamp: number }) => void
  ): (() => void) => {
    return window.electron.system.onWake(callback);
  },
} as const;
