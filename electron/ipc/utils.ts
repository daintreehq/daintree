import { BrowserWindow, ipcMain } from "electron";
import type { IpcInvokeMap, IpcEventMap } from "../types/index.js";
import { performance } from "node:perf_hooks";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import {
  isPerformanceCaptureEnabled,
  markPerformance,
  sampleIpcTiming,
} from "../utils/performance.js";

const rateLimitTimestamps = new Map<string, number[]>();

type RateLimitCategory = "fileOps" | "gitOps" | "terminalSpawn";

const channelToCategory: Record<string, RateLimitCategory> = {
  "copytree:generate": "fileOps",
  "copytree:generate-and-copy-file": "fileOps",
  "copytree:inject": "fileOps",
  "copytree:get-file-tree": "fileOps",
  "copytree:test-config": "fileOps",
  "worktree:create": "gitOps",
  "worktree:delete": "gitOps",
  "worktree:create-for-task": "gitOps",
  "worktree:cleanup-task": "gitOps",
  "git:get-file-diff": "gitOps",
  "git:get-project-pulse": "gitOps",
  "git:list-commits": "gitOps",
  "terminal:spawn": "terminalSpawn",
};

export function checkRateLimit(channel: string, maxCalls: number, windowMs: number): void {
  const category = channelToCategory[channel];
  const key = category ?? channel;
  const now = Date.now();
  const timestamps = (rateLimitTimestamps.get(key) ?? []).filter((t) => now - t < windowMs);
  if (timestamps.length >= maxCalls) {
    throw new Error("Rate limit exceeded");
  }
  timestamps.push(now);
  rateLimitTimestamps.set(key, timestamps);
}

export function sendToRenderer(
  mainWindow: BrowserWindow,
  channel: string,
  ...args: unknown[]
): void {
  const webContents = mainWindow?.webContents;
  if (!mainWindow || mainWindow.isDestroyed() || !webContents) {
    return;
  }

  if (typeof webContents.send !== "function") {
    return;
  }

  if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) {
    return;
  }

  try {
    webContents.send(channel, ...args);
  } catch {
    // Silently ignore send failures during window initialization/disposal.
  }
}

export function typedHandle<K extends keyof IpcInvokeMap>(
  channel: K,
  handler: (
    ...args: IpcInvokeMap[K]["args"]
  ) => Promise<IpcInvokeMap[K]["result"]> | IpcInvokeMap[K]["result"]
): () => void {
  const captureEnabled = isPerformanceCaptureEnabled();
  let requestCounter = 0;

  ipcMain.handle(channel as string, async (_event, ...args) => {
    if (!captureEnabled) {
      return await handler(...(args as IpcInvokeMap[K]["args"]));
    }

    const traceId = `${String(channel)}-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
    const startedAt = performance.now();
    markPerformance(PERF_MARKS.IPC_REQUEST_START, {
      channel: channel as string,
      traceId,
      argCount: args.length,
    });

    let responsePayload: IpcInvokeMap[K]["result"] | undefined;
    let errored = false;

    try {
      responsePayload = await handler(...(args as IpcInvokeMap[K]["args"]));
      return responsePayload;
    } catch (error) {
      errored = true;
      throw error;
    } finally {
      const durationMs = performance.now() - startedAt;
      markPerformance(PERF_MARKS.IPC_REQUEST_END, {
        channel: channel as string,
        traceId,
        durationMs,
        ok: !errored,
      });
      sampleIpcTiming(channel as string, durationMs, {
        traceId,
        requestPayload: args,
        responsePayload,
        errored,
      });
    }
  });
  return () => ipcMain.removeHandler(channel as string);
}

export function typedSend<K extends keyof IpcEventMap>(
  window: BrowserWindow,
  channel: K,
  payload: IpcEventMap[K]
): void {
  const webContents = window?.webContents;
  if (!window || window.isDestroyed() || !webContents) {
    return;
  }

  if (typeof webContents.send !== "function") {
    return;
  }

  if (typeof webContents.isDestroyed === "function" && webContents.isDestroyed()) {
    return;
  }

  try {
    webContents.send(channel as string, payload);
  } catch {
    // Silently ignore send failures during window initialization/disposal.
  }
}
