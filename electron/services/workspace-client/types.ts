import type { WebContents } from "electron";
import type { WorkspaceHostProcess } from "../WorkspaceHostProcess.js";
import type { CopyTreeProgress } from "../../../shared/types/ipc.js";

export type CopyTreeProgressCallback = (progress: CopyTreeProgress) => void;

export interface ProcessEntry {
  host: WorkspaceHostProcess;
  refCount: number;
  initPromise: Promise<void>;
  currentReadyPromise: Promise<void>;
  cleanupTimeout: NodeJS.Timeout | null;
  windowIds: Set<number>;
  projectPath: string;
  directPortViews: Map<number, WebContents>;
}

export function sendToEntryWindows(entry: ProcessEntry, channel: string, ...args: unknown[]): void {
  for (const [wcId, wc] of entry.directPortViews) {
    if (wc.isDestroyed()) {
      entry.directPortViews.delete(wcId);
      continue;
    }
    try {
      wc.send(channel, ...args);
    } catch {
      // Silently ignore send failures during window initialization/disposal.
    }
  }
}
