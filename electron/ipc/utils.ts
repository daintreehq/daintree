import { BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import {
  getWindowForWebContents,
  getAppWebContents,
  getAllAppWebContents,
} from "../window/webContentsRegistry.js";
import { getProjectViewManager } from "../window/windowRef.js";
import type { IpcInvokeMap, IpcEventMap } from "../types/index.js";
import type { IpcContext } from "./types.js";
import { ValidationError } from "./validationError.js";
import type { ForbidIpcEnvelopeKeys } from "../../shared/types/ipc/errors.js";
import { performance } from "node:perf_hooks";
import { PERF_MARKS } from "../../shared/perf/marks.js";
import {
  isPerformanceCaptureEnabled,
  markPerformance,
  sampleIpcTiming,
} from "../utils/performance.js";
import { AppError } from "../utils/errorTypes.js";
import { assertIpcSecurityReady } from "./ipcGuard.js";

/**
 * Parse the first argument of an IPC payload against a Zod schema. On
 * failure: log the full Zod issue list locally (main process only) and throw
 * a sanitized {@link ValidationError}. The Zod issues, field paths, and
 * user-supplied values are NEVER included in the thrown message.
 *
 * Returns the parsed `z.output<S>` so transform-bearing schemas (e.g. clamps,
 * defaults) pass their post-parse value into the handler.
 */
function parseIpcPayload<S extends z.ZodTypeAny>(
  channel: string,
  schema: S,
  payload: unknown
): z.output<S> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error(`[IPC] Validation failed for ${channel}:`, parsed.error.flatten());
    throw new ValidationError(channel);
  }
  return parsed.data;
}

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
    throw new AppError({
      code: "RATE_LIMITED",
      message: "Rate limit exceeded",
      userMessage: "Slow down — too many requests in a short window.",
      context: { channel, maxCalls, windowMs },
    });
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

interface LeakyBucketWaiter {
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface LeakyBucketState {
  nextAvailableMs: number;
  pendingCount: number;
  waiters: Set<LeakyBucketWaiter>;
}

const MAX_QUEUE_DEPTH = 50;
const rateLimitQueues = new Map<string, RateLimitState>();
const leakyBucketQueues = new Map<string, LeakyBucketState>();

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

function getOrCreateLeakyState(key: string): LeakyBucketState {
  let state = leakyBucketQueues.get(key);
  if (!state) {
    state = { nextAvailableMs: 0, pendingCount: 0, waiters: new Set() };
    leakyBucketQueues.set(key, state);
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

/**
 * Reserve a rate-limit slot and wait until it is ready.
 *
 * Two modes:
 *
 * 1. `waitForRateLimitSlot(key, intervalMs)` — **strict-interval leaky bucket.**
 *    Guarantees at most one caller is released every `intervalMs` milliseconds.
 *    Concurrent callers claim sequential slots synchronously at call time, so
 *    a burst of N `Promise.all` callers is released steadily at
 *    `intervalMs` spacing rather than in batches. Use this for operations that
 *    must be serialised with a smooth cadence (e.g. git worktree creation).
 *
 * 2. `waitForRateLimitSlot(key, maxCalls, windowMs)` — **sliding window.**
 *    Up to `maxCalls` callers may run within any `windowMs` window; excess
 *    callers queue and drain as the window rolls forward. Suited to callers
 *    that accept bursts but need an overall cap. Note that this variant
 *    produces step-function pauses for sustained batches once `maxCalls` is
 *    hit — prefer the leaky-bucket form for smooth batch cadence.
 */
export async function waitForRateLimitSlot(key: string, intervalMs: number): Promise<void>;
export async function waitForRateLimitSlot(
  key: string,
  maxCalls: number,
  windowMs: number
): Promise<void>;
export async function waitForRateLimitSlot(
  key: string,
  maxCallsOrInterval: number,
  windowMs?: number
): Promise<void> {
  if (windowMs === undefined) {
    return waitForLeakyBucketSlot(key, maxCallsOrInterval);
  }
  return waitForSlidingWindowSlot(key, maxCallsOrInterval, windowMs);
}

async function waitForLeakyBucketSlot(key: string, intervalMs: number): Promise<void> {
  if (intervalMs <= 0) return;

  const state = getOrCreateLeakyState(key);

  if (state.pendingCount >= MAX_QUEUE_DEPTH) {
    throw new AppError({
      code: "RATE_LIMITED",
      message: "Spawn queue full",
      userMessage: "Too many pending operations — wait a moment and try again.",
      context: { key, queueDepth: state.pendingCount, maxDepth: MAX_QUEUE_DEPTH },
    });
  }

  // Synchronous slot reservation — MUST happen before any await so that
  // concurrent callers each claim a unique sequential slot. If this advance
  // happened after an await, two simultaneous callers could both read the
  // same `nextAvailableMs` and end up scheduled for the same instant.
  const now = Date.now();
  const slotMs = Math.max(now, state.nextAvailableMs);
  state.nextAvailableMs = slotMs + intervalMs;
  const waitMs = slotMs - now;

  if (waitMs <= 0) return;

  state.pendingCount++;
  try {
    await new Promise<void>((resolve, reject) => {
      const waiter: LeakyBucketWaiter = {
        reject,
        timer: setTimeout(() => {
          state.waiters.delete(waiter);
          resolve();
        }, waitMs),
      };
      state.waiters.add(waiter);
    });
  } finally {
    state.pendingCount--;
  }
}

async function waitForSlidingWindowSlot(
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
    throw new AppError({
      code: "RATE_LIMITED",
      message: "Spawn queue full",
      userMessage: "Too many pending operations — wait a moment and try again.",
      context: { key, queueDepth: state.queue.length, maxDepth: MAX_QUEUE_DEPTH },
    });
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
  // Cancel all in-flight leaky-bucket waiters. Matching the sliding-window
  // semantics is important: without this, waiters resume after drain and
  // their callers proceed past the await into real work (e.g. creating
  // worktrees) during shutdown, racing workspace-client teardown.
  for (const [, state] of leakyBucketQueues) {
    for (const waiter of state.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("App is shutting down"));
    }
    state.waiters.clear();
  }
  leakyBucketQueues.clear();
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

if (process.env.DAINTREE_E2E_FAULT_MODE === "1") {
  (globalThis as Record<string, unknown>).__daintreeResetRateLimits = _resetRateLimitQueuesForTest;
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
  ) =>
    | Promise<ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>>
    | ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>
): () => void {
  assertIpcSecurityReady(channel as string);
  const captureEnabled = isPerformanceCaptureEnabled();
  let requestCounter = 0;

  // Fast path: when perf capture is disabled, skip the async wrapper so
  // synchronous handlers stay synchronous (preserves existing behavior for
  // handlers that returned values directly when registered via ipcMain.handle).
  if (!captureEnabled) {
    ipcMain.handle(channel as string, (_event, ...args) =>
      handler(...(args as IpcInvokeMap[K]["args"]))
    );
    return () => ipcMain.removeHandler(channel as string);
  }

  ipcMain.handle(channel as string, async (_event, ...args) => {
    const traceId = `${String(channel)}-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
    const startedAt = performance.now();
    markPerformance(PERF_MARKS.IPC_REQUEST_START, {
      channel: channel as string,
      traceId,
      argCount: args.length,
    });

    let responsePayload: ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]> | undefined;
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

/**
 * Same as {@link typedHandle}, but parses the first argument with `schema`
 * before invoking the handler. On parse failure: log issues locally, throw a
 * sanitized {@link ValidationError}. The handler receives `z.output<S>`.
 *
 * Use for ad-hoc handlers that aren't (yet) wired through `defineIpcNamespace`.
 * For namespace-bound handlers prefer `opValidated()` from `./define.js`.
 */
export function typedHandleValidated<K extends keyof IpcInvokeMap, S extends z.ZodTypeAny>(
  channel: K,
  schema: S,
  handler: (payload: z.output<S>) => Promise<IpcInvokeMap[K]["result"]> | IpcInvokeMap[K]["result"]
): () => void {
  assertIpcSecurityReady(channel as string);
  // Wrap as async so a synchronous throw from `parseIpcPayload` always
  // surfaces as a rejected promise. `ipcMain.handle` accepts both forms in
  // production, but normalising here keeps test mocks consistent and makes
  // the contract explicit.
  const wrapped = (async (...args: unknown[]) => {
    const parsed = parseIpcPayload(channel as string, schema, args[0]);
    return handler(parsed);
  }) as unknown as (
    ...args: IpcInvokeMap[K]["args"]
  ) => Promise<ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>>;
  return typedHandle(channel, wrapped);
}

export function typedHandleWithContext<K extends keyof IpcInvokeMap>(
  channel: K,
  handler: (
    ctx: IpcContext,
    ...args: IpcInvokeMap[K]["args"]
  ) =>
    | Promise<ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>>
    | ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>
): () => void {
  assertIpcSecurityReady(channel as string);
  const captureEnabled = isPerformanceCaptureEnabled();
  let requestCounter = 0;

  if (!captureEnabled) {
    ipcMain.handle(channel as string, (event, ...args) => {
      const webContentsId = event.sender.id;
      const senderWindow = getWindowForWebContents(event.sender);
      const projectId = getProjectViewManager()?.getProjectIdForWebContents(webContentsId) ?? null;
      const ctx: IpcContext = { event, webContentsId, senderWindow, projectId };
      return handler(ctx, ...(args as IpcInvokeMap[K]["args"]));
    });
    return () => ipcMain.removeHandler(channel as string);
  }

  ipcMain.handle(channel as string, async (event, ...args) => {
    const webContentsId = event.sender.id;
    const senderWindow = getWindowForWebContents(event.sender);
    const projectId = getProjectViewManager()?.getProjectIdForWebContents(webContentsId) ?? null;
    const ctx: IpcContext = { event, webContentsId, senderWindow, projectId };

    const traceId = `${String(channel)}-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
    const startedAt = performance.now();
    markPerformance(PERF_MARKS.IPC_REQUEST_START, {
      channel: channel as string,
      traceId,
      argCount: args.length,
    });

    let responsePayload: ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]> | undefined;
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

/**
 * Same as {@link typedHandleWithContext}, but parses the first argument with
 * `schema` before invoking the handler. On parse failure: log issues locally,
 * throw a sanitized {@link ValidationError}. The handler receives `ctx` and
 * `z.output<S>`.
 */
export function typedHandleWithContextValidated<
  K extends keyof IpcInvokeMap,
  S extends z.ZodTypeAny,
>(
  channel: K,
  schema: S,
  handler: (
    ctx: IpcContext,
    payload: z.output<S>
  ) => Promise<IpcInvokeMap[K]["result"]> | IpcInvokeMap[K]["result"]
): () => void {
  assertIpcSecurityReady(channel as string);
  // Wrap as async so synchronous parse throws become rejected promises.
  const wrapped = (async (ctx: IpcContext, ...args: unknown[]) => {
    const parsed = parseIpcPayload(channel as string, schema, args[0]);
    return handler(ctx, parsed);
  }) as unknown as (
    ctx: IpcContext,
    ...args: IpcInvokeMap[K]["args"]
  ) => Promise<ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>>;
  return typedHandleWithContext(channel, wrapped);
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
