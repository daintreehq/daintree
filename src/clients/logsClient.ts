import type { LogEntry, LogFilterOptions } from "@shared/types";

/**
 * @example
 * ```typescript
 * import { logsClient } from "@/clients/logsClient";
 *
 * const logs = await logsClient.getAll({ levels: ["error", "warn"] });
 * const cleanup = logsClient.onEntry((entry) => console.log(entry));
 * await logsClient.setVerbose(true); // Enable verbose logging
 * ```
 */
export const logsClient = {
  getAll: (filters?: LogFilterOptions): Promise<LogEntry[]> => {
    return window.electron.logs.getAll(filters);
  },

  getSources: (): Promise<string[]> => {
    return window.electron.logs.getSources();
  },

  clear: (): Promise<void> => {
    return window.electron.logs.clear();
  },

  openFile: (): Promise<void> => {
    return window.electron.logs.openFile();
  },

  setVerbose: (enabled: boolean): Promise<void> => {
    return window.electron.logs.setVerbose(enabled);
  },

  getVerbose: (): Promise<boolean> => {
    return window.electron.logs.getVerbose();
  },

  onEntry: (callback: (entry: LogEntry) => void): (() => void) => {
    return window.electron.logs.onEntry(callback);
  },

  onBatch: (callback: (entries: LogEntry[]) => void): (() => void) => {
    return window.electron.logs.onBatch(callback);
  },

  getLevelOverrides: (): Promise<Record<string, string>> => {
    return window.electron.logs.getLevelOverrides();
  },

  setLevelOverrides: (overrides: Record<string, string>): Promise<{ success: boolean }> => {
    return window.electron.logs.setLevelOverrides(overrides);
  },

  clearLevelOverrides: (): Promise<{ success: boolean }> => {
    return window.electron.logs.clearLevelOverrides();
  },

  getRegistry: (): Promise<string[]> => {
    return window.electron.logs.getRegistry();
  },
} as const;
