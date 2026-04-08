import { BrowserWindow, ipcMain } from "electron";
import {
  getWindowForWebContents,
  getAppWebContents,
  getAllAppWebContents,
} from "../window/webContentsRegistry.js";
import { getProjectViewManager } from "../window/windowRef.js";
import type { IpcInvokeMap, IpcEventMap } from "../types/index.js";
import type { IpcContext } from "./types.js";
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

interface RateLimitQueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
}

interface RateLimitState {
  timestamps: number[];
  queue: RateLimitQueueEntry[];
  timer: ReturnType<typeof setTimeout> | null;
}

const MAX_QUEUE_DEPTH = 50;
const rateLimitQueues = new Map<string, RateLimitState>();

let restoreQuota = 0;
let restoreQuotaTimer: ReturnType<typeof setTimeout> | null = null;

export function armRestoreQuota(count: number, ttlMs: number): void {
  restoreQuota = count;
  if (restoreQuotaTimer !== null) {
    clearTimeout(restoreQuotaTimer);
  }
  restoreQuotaTimer = setTimeout(() => {
    restoreQuota = 0;
    restoreQuotaTimer = null;
  }, ttlMs);
}

export function consumeRestoreQuota(): boolean {
  if (restoreQuota <= 0) return false;
  restoreQuota--;
  return true;
}

function getOrCreateState(key: string): RateLimitState {
  let state = rateLimitQueues.get(key);
  if (!state) {
    state = { timestamps: [], queue: [], timer: null };
    rateLimitQueues.set(key, state);
  }
  return state;
}

function drainQueue(state: RateLimitState, maxCalls: number, windowMs: number): void {
  const now = Date.now();
  state.timestamps = state.timestamps.filter((t) => now - t < windowMs);

  while (state.queue.length > 0 && state.timestamps.length < maxCalls) {
    state.timestamps.push(Date.now());
    const entry = state.queue.shift()!;
    entry.resolve();
  }

  scheduleDrain(state, maxCalls, windowMs);
}

function scheduleDrain(state: RateLimitState, maxCalls: number, windowMs: number): void {
  if (state.timer !== null) return;
  if (state.queue.length === 0) return;
  if (state.timestamps.length === 0) return;

  const delay = Math.max(0, state.timestamps[0] + windowMs - Date.now());
  state.timer = setTimeout(() => {
    state.timer = null;
    drainQueue(state, maxCalls, windowMs);
  }, delay);
}

export async function waitForRateLimitSlot(
  key: string,
  maxCalls: number,
  windowMs: number
): Promise<void> {
  const state = getOrCreateState(key);
  const now = Date.now();
  state.timestamps = state.timestamps.filter((t) => now - t < windowMs);

  if (state.timestamps.length < maxCalls && state.queue.length === 0) {
    state.timestamps.push(now);
    return;
  }

  if (state.queue.length >= MAX_QUEUE_DEPTH) {
    throw new Error("Spawn queue full");
  }

  return new Promise<void>((resolve, reject) => {
    state.queue.push({ resolve, reject });
    scheduleDrain(state, maxCalls, windowMs);
  });
}

export function drainRateLimitQueues(): void {
  for (const [, state] of rateLimitQueues) {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    while (state.queue.length > 0) {
      const entry = state.queue.shift()!;
      entry.reject(new Error("App is shutting down"));
    }
  }
  rateLimitQueues.clear();
}

export function _resetRateLimitQueuesForTest(): void {
  drainRateLimitQueues();
  rateLimitTimestamps.clear();
  restoreQuota = 0;
  if (restoreQuotaTimer !== null) {
    clearTimeout(restoreQuotaTimer);
    restoreQuotaTimer = null;
  }
}

if (process.env.CANOPY_E2E_FAULT_MODE === "1") {
  (globalThis as Record<string, unknown>).__canopyResetRateLimits = _resetRateLimitQueuesForTest;
}

export function sendToRenderer(
  mainWindow: BrowserWindow,
  channel: string,
  ...args: unknown[]
): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const webContents = getAppWebContents(mainWindow);

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

export function broadcastToRenderer(channel: string, ...args: unknown[]): void {
  for (const wc of getAllAppWebContents()) {
    if (!wc.isDestroyed()) {
      try {
        wc.send(channel, ...args);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
  }
}

export function sendToRendererContext(ctx: IpcContext, channel: string, ...args: unknown[]): void {
  if (ctx.senderWindow === null) return;
  sendToRenderer(ctx.senderWindow, channel, ...args);
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

export function typedHandleWithContext<K extends keyof IpcInvokeMap>(
  channel: K,
  handler: (
    ctx: IpcContext,
    ...args: IpcInvokeMap[K]["args"]
  ) => Promise<IpcInvokeMap[K]["result"]> | IpcInvokeMap[K]["result"]
): () => void {
  const captureEnabled = isPerformanceCaptureEnabled();
  let requestCounter = 0;

  ipcMain.handle(channel as string, async (event, ...args) => {
    const webContentsId = event.sender.id;
    const senderWindow = getWindowForWebContents(event.sender);
    const projectId = getProjectViewManager()?.getProjectIdForWebContents(webContentsId) ?? null;
    const ctx: IpcContext = { event, webContentsId, senderWindow, projectId };

    if (!captureEnabled) {
      return await handler(ctx, ...(args as IpcInvokeMap[K]["args"]));
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
      responsePayload = await handler(ctx, ...(args as IpcInvokeMap[K]["args"]));
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

export function typedBroadcast<K extends keyof IpcEventMap>(
  channel: K,
  payload: IpcEventMap[K]
): void {
  for (const wc of getAllAppWebContents()) {
    if (!wc.isDestroyed()) {
      try {
        wc.send(channel as string, payload);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
  }
}

export function typedSend<K extends keyof IpcEventMap>(
  window: BrowserWindow,
  channel: K,
  payload: IpcEventMap[K]
): void {
  if (!window || window.isDestroyed()) {
    return;
  }

  const webContents = getAppWebContents(window);

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
