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

  healthCheck: (agentIds?: string[]): ReturnType<typeof window.electron.system.healthCheck> => {
    return window.electron.system.healthCheck(agentIds);
  },

  getHealthCheckSpecs: (
    agentIds?: string[]
  ): ReturnType<typeof window.electron.system.getHealthCheckSpecs> => {
    return window.electron.system.getHealthCheckSpecs(agentIds);
  },

  checkTool: (
    spec: Parameters<typeof window.electron.system.checkTool>[0]
  ): ReturnType<typeof window.electron.system.checkTool> => {
    return window.electron.system.checkTool(spec);
  },

  downloadDiagnostics: (): Promise<boolean> => {
    return window.electron.system.downloadDiagnostics();
  },

  collectDiagnosticsForReview: (): Promise<
    import("@shared/types/ipc/system").DiagnosticsReviewPayload
  > => {
    return window.electron.system.collectDiagnosticsForReview();
  },

  saveDiagnosticsBundle: (
    payload: import("@shared/types/ipc/system").DiagnosticsBundleSavePayload
  ): Promise<boolean> => {
    return window.electron.system.saveDiagnosticsBundle(payload);
  },

  getAppMetrics: (): ReturnType<typeof window.electron.system.getAppMetrics> => {
    return window.electron.system.getAppMetrics();
  },

  getHardwareInfo: (): ReturnType<typeof window.electron.system.getHardwareInfo> => {
    return window.electron.system.getHardwareInfo();
  },

  getProcessMetrics: (): ReturnType<typeof window.electron.system.getProcessMetrics> => {
    return window.electron.system.getProcessMetrics();
  },

  getHeapStats: (): ReturnType<typeof window.electron.system.getHeapStats> => {
    return window.electron.system.getHeapStats();
  },

  getDiagnosticsInfo: (): ReturnType<typeof window.electron.system.getDiagnosticsInfo> => {
    return window.electron.system.getDiagnosticsInfo();
  },

  onWake: (
    callback: (data: { sleepDuration: number; timestamp: number }) => void
  ): (() => void) => {
    return window.electron.system.onWake(callback);
  },
} as const;
