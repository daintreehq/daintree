import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { z } from "zod";
import {
  getWindowForWebContents,
  getAppWebContents,
  getAllAppWebContents,
  getProjectForWebContents,
  getRegisteredProjectViews,
  getShownAppWebContents,
  getWebContentsForProject,
  hasRegisteredProjectViews,
  isCachedViewWebContents,
} from "../window/webContentsRegistry.js";
import { getWindowRegistry } from "../window/windowRef.js";
import { isViewHydrated } from "../window/viewHydration.js";
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
import { isE2EFaultMode } from "../setup/runtimeFlags.js";
import type { ClientEndpoint, EndpointGroup, HostFrame } from "./endpoint.js";
import { getIpcDispatcher } from "./dispatcher.js";
import { getEndpointRegistry } from "./endpointRegistry.js";
import { getLocalClientRef, getLocalEndpoint } from "./localEndpoint.js";

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
    console.error(`[IPC] Validation failed for ${channel}:`, z.prettifyError(parsed.error));
    throw new ValidationError(channel);
  }
  return parsed.data;
}

const rateLimitTimestamps = new Map<string, number[]>();

export type IpcChannelCategory =
  "fileOps" | "artifactOps" | "gitOps" | "terminalSpawn" | "pluginInvoke";

export const channelToCategory: Record<string, IpcChannelCategory> = {
  "copytree:generate": "fileOps",
  "copytree:generate-and-copy-file": "fileOps",
  "copytree:inject": "fileOps",
  "copytree:get-file-tree": "fileOps",
  "copytree:test-config": "fileOps",
  "artifact:apply-patch": "artifactOps",
  "artifact:save-to-file": "artifactOps",
  "worktree:create": "gitOps",
  "worktree:delete": "gitOps",
  "git:get-file-diff": "gitOps",
  "git:get-project-pulse": "gitOps",
  "git:list-commits": "gitOps",
  "terminal:spawn": "terminalSpawn",
  "plugin:invoke": "pluginInvoke",
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

/**
 * Arm the restore-spawn bypass budget. Every window's init calls this, so while
 * a quota is live a later call must not refill it: resetting per window handed
 * each restored window a fresh budget and the quota never limited a multi-window
 * restore as a whole (#12800). Once it expires, the next window arms a new one.
 */
export function armRestoreQuota(count: number, ttlMs: number): void {
  if (restoreQuotaTimer !== null) return;
  restoreQuota = count;
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

/**
 * Token-bucket variant of the leaky bucket: `burst` callers may pass with no
 * wait after an idle stretch, then sustained callers drain at one per
 * `intervalMs` (identical to the leaky bucket). A burst allowance of 1 IS the
 * leaky bucket. Use for interactive operations where a small user-driven
 * burst (e.g. launching several agents back-to-back) must not serialize onto
 * the sustained cadence, while runaway automation still hits the same
 * long-run rate.
 */
export async function waitForBurstRateLimitSlot(
  key: string,
  intervalMs: number,
  burst: number
): Promise<void> {
  return waitForLeakyBucketSlot(key, intervalMs, burst);
}

async function waitForLeakyBucketSlot(key: string, intervalMs: number, burst = 1): Promise<void> {
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
  //
  // The burst allowance banks idle time: clamping the reserved slot from
  // below at `now - (burst - 1) * intervalMs` lets up to `burst` reservations
  // land at-or-before `now` (zero wait) before the schedule pushes into the
  // future, after which callers space out at `intervalMs` exactly like the
  // plain leaky bucket.
  const now = Date.now();
  const slotMs = Math.max(now - (Math.max(1, burst) - 1) * intervalMs, state.nextAvailableMs);
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

if (isE2EFaultMode) {
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

  if (isWithheldFromView(webContents.id, channel, args)) return;

  try {
    webContents.send(channel, ...args);
  } catch {
    // Silently ignore send failures during window initialization/disposal.
  }
}

function sendToEndpoints(
  endpoints: readonly ClientEndpoint[],
  exclude: ReadonlySet<number> | null,
  channel: string,
  args: unknown[]
): void {
  for (const endpoint of endpoints) {
    if (endpoint.kind !== "remote-view" || endpoint.isClosed()) continue;
    if (exclude?.has(endpoint.handle)) continue;
    try {
      endpoint.send({ type: "event", channel, args });
    } catch {
      // A closing link must not break delivery to the remaining endpoints.
    }
  }
}

/**
 * Pushes to every remote view. A link session's views share a group, so the
 * session gets one copy for all of them; project-scoped and excluding pushes
 * still address each endpoint, since a group can't leave any of its views out.
 */
export function broadcastToRemoteEndpoints(channel: string, args: unknown[]): void {
  const registry = getEndpointRegistry();
  if (!registry.hasRemote()) return;
  const frame: HostFrame = { type: "event", channel, args };
  let pushed: Set<EndpointGroup> | null = null;
  for (const endpoint of registry.getRemote()) {
    if (endpoint.kind !== "remote-view" || endpoint.isClosed()) continue;
    const group = endpoint.group;
    if (group) {
      pushed ??= new Set();
      if (pushed.has(group)) continue;
      pushed.add(group);
    }
    try {
      if (group) group.sendToAll(frame);
      else endpoint.send(frame);
    } catch {
      // A closing link must not break delivery to the remaining endpoints.
    }
  }
}

/**
 * Decides whether a push produced on this machine may reach one of its views.
 * Returns false for a view bound to a remote host that must not see it: that
 * view shows the host's agents and projects, not this machine's.
 */
export type RemoteBoundViewFilter = (
  webContentsId: number,
  channel: string,
  args: readonly unknown[]
) => boolean;

// Null until Remote Hosts is actually used, so local delivery pays one null check.
let remoteBoundViewFilter: RemoteBoundViewFilter | null = null;

/** Installed by the Remote Hosts boot the first time a host is used. */
export function setRemoteBoundViewFilter(filter: RemoteBoundViewFilter | null): () => void {
  remoteBoundViewFilter = filter;
  return () => {
    if (remoteBoundViewFilter === filter) remoteBoundViewFilter = null;
  };
}

/**
 * Whether a push from this machine is kept from a view: a view bound to a
 * remote host hears that host's state, not this machine's. Every direct
 * `send` of a local push to an arbitrary view goes through this.
 */
export function isWithheldFromView(
  webContentsId: number,
  channel: string,
  args: unknown[]
): boolean {
  const filter = remoteBoundViewFilter;
  return filter !== null && !filter(webContentsId, channel, args);
}

export function broadcastToRenderer(channel: string, ...args: unknown[]): void {
  for (const wc of getAllAppWebContents()) {
    if (!wc.isDestroyed()) {
      if (isWithheldFromView(wc.id, channel, args)) continue;
      try {
        wc.send(channel, ...args);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
  }
  broadcastToRemoteEndpoints(channel, args);
}

/**
 * Project-scoped broadcast for per-terminal hot streams (terminal data,
 * flow-status pulses, activity headlines): one structured clone + renderer IPC
 * task per VIEW OF THE OWNING PROJECT instead of per WebContents in the app.
 * Cached views of the project are included — these streams have no replay
 * path on warm reactivation (#9490). Falls back to a full broadcast when the
 * terminal's project is unknown or no project views are registered (startup /
 * windows that don't route through ProjectViewManager); when project views
 * exist but none host this project, no renderer has panels for the terminal
 * and the event is dropped.
 *
 * Safe for TERMINAL_DATA's IPC fallback, which exists because the pty-host's
 * per-window MessagePort filter keys off `windowProjectMap` and can lag a
 * project switch (src/clients/terminalClient.ts onData). This scoping keys off
 * the view registry instead, which is bound per view and registered before the
 * view loads, so the owning project's view — active or cached — still gets the
 * bytes mid-switch.
 */
export function broadcastToProjectRenderers(
  projectId: string | null,
  channel: string,
  ...args: unknown[]
): void {
  broadcastToProjectRenderersExcept(projectId, null, channel, ...args);
}

/**
 * The live local renderers {@link broadcastToProjectRenderers} would reach.
 * Remote views are not among them; {@link getProjectPushTargets} adds those.
 */
export function getProjectRendererTargets(projectId: string | null): WebContents[] {
  if (projectId !== null && hasRegisteredProjectViews()) {
    return getWebContentsForProject(projectId);
  }
  return getAllAppWebContents().filter((wc) => !wc.isDestroyed());
}

/**
 * One recipient of a push a caller delivers per renderer itself: a local
 * `WebContents`, or a remote view's endpoint, whose `id` is its (negative)
 * handle — the same number its IPC context reports as `webContentsId`.
 */
export interface ProjectPushTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

// One adapter per endpoint, so a caller keying recipients by identity sees a
// remote view as the same target from one flush to the next.
const endpointPushTargets = new WeakMap<ClientEndpoint, ProjectPushTarget>();

/** A remote view as a {@link ProjectPushTarget}, for a caller replaying state to one view. */
export function endpointPushTarget(endpoint: ClientEndpoint): ProjectPushTarget {
  let target = endpointPushTargets.get(endpoint);
  if (!target) {
    target = {
      id: endpoint.handle,
      isDestroyed: () => endpoint.isClosed(),
      send: (channel, ...args) => endpoint.send({ type: "event", channel, args }),
    };
    endpointPushTargets.set(endpoint, target);
  }
  return target;
}

/**
 * Everyone {@link broadcastToProjectRenderers} would reach with `channel`, for
 * callers that deliver per renderer themselves (the plugin push batcher and
 * its listener signal): the project's local views, less any bound to a remote
 * host that must not see this machine's `channel`, plus the remote views
 * attached to the project. `null` is every renderer and every remote view.
 */
export function getProjectPushTargets(
  projectId: string | null,
  channel: string
): ProjectPushTarget[] {
  const targets: ProjectPushTarget[] = getProjectRendererTargets(projectId).filter(
    (wc) => !isWithheldFromView(wc.id, channel, [])
  );
  const registry = getEndpointRegistry();
  if (!registry.hasRemote()) return targets;
  const endpoints = projectId !== null ? registry.getForProject(projectId) : registry.getRemote();
  for (const endpoint of endpoints) {
    if (endpoint.kind === "remote-view" && !endpoint.isClosed()) {
      targets.push(endpointPushTarget(endpoint));
    }
  }
  return targets;
}

/**
 * {@link broadcastToProjectRenderers} minus a set of WebContents ids.
 *
 * The one caller is TERMINAL_DATA (#12557). A cached duplicate view has no
 * MessagePort of its own, so the pty-host keeps the IPC fallback open for it
 * even when a sibling window's port already took the chunk — and names the
 * windows it fed. Their port-holder views must be excluded here or the chunk
 * lands in the same xterm twice (terminalClient.onData subscribes to both the
 * port and the IPC path).
 *
 * Exclusions apply to the unscoped fallback path too. That branch also runs
 * for a terminal whose project Main can no longer name — `getTerminalProjectId`
 * starts returning null the moment `PtyClient.kill()` drops the spawn record,
 * while chunks the host already emitted are still arriving — and a port holder
 * that just read the chunk off its port must not receive it again merely
 * because the routing hint went missing.
 */
export function broadcastToProjectRenderersExcept(
  projectId: string | null,
  exclude: ReadonlySet<number> | null,
  channel: string,
  ...args: unknown[]
): void {
  deliverToLocalProjectViews(projectId, exclude, channel, args);
  // Remote endpoints are always bound to one project, so a known project
  // scopes them regardless of local views: a windowless host has none, and
  // falling back there would push one project's events to every Shell.
  const registry = getEndpointRegistry();
  if (!registry.hasRemote()) return;
  sendToEndpoints(
    projectId !== null ? registry.getForProject(projectId) : registry.getRemote(),
    exclude,
    channel,
    args
  );
}

function deliverToLocalProjectViews(
  projectId: string | null,
  exclude: ReadonlySet<number> | null,
  channel: string,
  args: unknown[]
): void {
  const scoped = projectId !== null && hasRegisteredProjectViews();
  const targets = scoped ? getWebContentsForProject(projectId) : getAllAppWebContents();
  for (const wc of targets) {
    // getWebContentsForProject already drops destroyed views.
    if (exclude?.has(wc.id) || (!scoped && wc.isDestroyed())) continue;
    if (isWithheldFromView(wc.id, channel, args)) continue;
    try {
      wc.send(channel, ...args);
    } catch {
      // Silently ignore send failures during window initialization/disposal.
    }
  }
}

/**
 * Project-scoped broadcast for a keyed batch that spans many projects (e.g.
 * per-terminal resource samples). Each project view — cached ones included, as
 * in {@link broadcastToProjectRenderers} — gets `wrap()` of its own project's
 * entries plus every entry whose project is unknown or has no resident view,
 * since those used to reach every renderer and still must reach some. Every
 * view gets a payload each call, even an empty one, so per-batch consumers keep
 * their cadence. With no live project views, every renderer gets the whole batch.
 */
export function broadcastSlicedToProjectRenderers<T>(
  channel: string,
  entries: Record<string, T>,
  ownerOf: (key: string) => string | null,
  wrap: (slice: Record<string, T>) => unknown
): void {
  const views = hasRegisteredProjectViews() ? getRegisteredProjectViews() : [];
  const registry = getEndpointRegistry();
  // Remote views are always bound to one project (or none), so they get their
  // own project's slice whether or not this machine has local views.
  const remotes = registry.hasRemote()
    ? registry.getRemote().filter((e) => e.kind === "remote-view" && !e.isClosed())
    : [];
  const byProject = new Map<string, Record<string, T>>();
  for (const { projectId } of views) byProject.set(projectId, {});
  for (const endpoint of remotes) {
    if (endpoint.projectId !== null) byProject.set(endpoint.projectId, {});
  }
  const shared: Record<string, T> = {};
  for (const [key, value] of Object.entries(entries)) {
    const owner = ownerOf(key);
    const slice = owner === null ? undefined : byProject.get(owner);
    (slice ?? shared)[key] = value;
  }
  const payloads = new Map<string | null, unknown>();
  const payloadFor = (projectId: string | null): unknown => {
    let payload = payloads.get(projectId);
    if (payload === undefined) {
      const own = projectId === null ? undefined : byProject.get(projectId);
      payload = wrap({ ...own, ...shared });
      payloads.set(projectId, payload);
    }
    return payload;
  };

  if (views.length === 0) {
    // No project views here: every local renderer gets the whole batch, as before.
    const whole = [wrap(entries)];
    for (const wc of getAllAppWebContents()) {
      if (wc.isDestroyed() || isWithheldFromView(wc.id, channel, whole)) continue;
      try {
        wc.send(channel, ...whole);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
  } else {
    for (const { webContents, projectId } of views) {
      const payload = payloadFor(projectId);
      if (isWithheldFromView(webContents.id, channel, [payload])) continue;
      try {
        webContents.send(channel, payload);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
  }
  for (const endpoint of remotes) {
    try {
      endpoint.send({ type: "event", channel, args: [payloadFor(endpoint.projectId)] });
    } catch {
      // A closing link must not break delivery to the remaining endpoints.
    }
  }
}

/**
 * Broadcast that skips cached (deactivated) project views. Two valid uses:
 *
 * - High-frequency streams the renderer can re-fetch on activation (e.g. log
 *   batches via LOGS_GET_ALL) — pushing them is wasted work in a cached
 *   renderer, and one that is frozen queues them unbounded in its task queue.
 * - Visibility-scoped effects whose audience is *defined* as the non-cached
 *   renderers at emission time. Dropping one must leave no stale state, no
 *   pending cleanup, and no missed user-significant information. An effect the
 *   machine should produce once, not once per window, wants
 *   {@link sendToOneVisibleRenderer} instead: every window's shown view is
 *   non-cached.
 *
 * If you cannot prove all three, use broadcastToRenderer. "Ephemeral" is not
 * the test: sound:cancel is a one-shot with nothing to replay, yet it must
 * reach cached views to stop a voice that started before caching. State
 * broadcasts likewise stay global — cached views have no replay path on warm
 * reactivation (#9490).
 *
 * A remote endpoint counts as visible: whether its view is cached is known
 * only to its own Shell.
 */
export function broadcastToVisibleRenderers(channel: string, ...args: unknown[]): void {
  for (const wc of getAllAppWebContents()) {
    if (isCachedViewWebContents(wc.id)) continue;
    if (!wc.isDestroyed()) {
      if (isWithheldFromView(wc.id, channel, args)) continue;
      try {
        wc.send(channel, ...args);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
  }
  broadcastToRemoteEndpoints(channel, args);
}

const singleTargetByChannel = new Map<string, number>();

function isSingleTargetEligible(wc: WebContents, channel: string, args: unknown[]): boolean {
  return (
    !wc.isDestroyed() &&
    !wc.isCrashed() &&
    !isCachedViewWebContents(wc.id) &&
    !isWithheldFromView(wc.id, channel, args)
  );
}

/** Rank per window: 0 for the window focused right now, then focus history. */
function windowFocusRanks(): Map<number, number> {
  const ranks = new Map<number, number>();
  const order = getWindowRegistry()?.focusOrder() ?? [];
  order.forEach((ctx, index) => {
    const win = ctx.browserWindow;
    if (win.isDestroyed()) return;
    ranks.set(win.id, win.isFocused() ? 0 : index + 1);
  });
  return ranks;
}

/** The view a cold switch is holding on screen while the incoming one loads. */
function isOutgoingBridge(wc: WebContents): boolean {
  const win = getWindowForWebContents(wc);
  if (!win || win.isDestroyed()) return false;
  const pvm = getWindowRegistry()?.getByWindowId(win.id)?.services.projectViewManager;
  const outgoing = pvm?.getOutgoingBridgeProjectId() ?? null;
  return outgoing !== null && pvm?.getProjectIdForWebContents(wc.id) === outgoing;
}

function singleTargetCandidates(channel: string, args: unknown[]): WebContents[] {
  const pool: WebContents[] = [];
  const seen = new Set<number>();
  const shownIds = new Set<number>();
  const consider = (wc: WebContents, shown: boolean): void => {
    if (wc.isDestroyed() || seen.has(wc.id)) return;
    seen.add(wc.id);
    if (shown) shownIds.add(wc.id);
    if (isSingleTargetEligible(wc, channel, args)) pool.push(wc);
  };
  const shown = getShownAppWebContents();
  for (const wc of shown) consider(wc, true);
  // A cold switch points the window at the incoming view before it loads,
  // while the outgoing one stays on screen, hydrated and listening. Other
  // uncached views are left out: a background restore is never attached, and
  // the efficiency sweep can freeze it before it is parked, so a send would
  // succeed and play late.
  const all = getAllAppWebContents();
  for (const wc of all) {
    if (!wc.isDestroyed() && !seen.has(wc.id) && isOutgoingBridge(wc)) consider(wc, false);
  }
  // No window has a registered shown view (early boot, or a window that never
  // registered one): any uncached renderer, still only one of them. Not when a
  // shown view exists but can't play (crashed): that would hand the sound to a
  // background restore.
  if (shown.length === 0 && pool.length === 0) {
    for (const wc of all) consider(wc, false);
  }
  if (pool.length <= 1) return pool;

  const sticky = singleTargetByChannel.get(channel);
  const focusRanks = windowFocusRanks();
  const keyOf = (wc: WebContents): number[] => {
    const win = getWindowForWebContents(wc);
    return [
      isViewHydrated(wc.id) ? 0 : 1,
      shownIds.has(wc.id) ? 0 : 1,
      wc.id === sticky ? 0 : 1,
      (win && focusRanks.get(win.id)) ?? Number.MAX_SAFE_INTEGER,
    ];
  };
  const keyed = pool.map((wc) => ({ wc, key: keyOf(wc) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    }
    return 0;
  });
  return keyed.map((entry) => entry.wc);
}

/**
 * Sends to exactly one local renderer, then to every remote endpoint, for an
 * effect this machine should produce once rather than once per window
 * (#15682). SOUND_TRIGGER is the case: every app view owns an AudioContext,
 * so even a visible-only broadcast played one copy per open window and kept
 * every window's context awake through a pulse train.
 *
 * Candidates are each window's shown view and any outgoing view a cold switch
 * still holds on screen. Choice, in order: a view whose current document has
 * hydrated (its listeners are mounted) over one still booting; a window's
 * shown view over one on its way out; the renderer that took this channel
 * last, so focus moving between windows doesn't wake a second context; the
 * window focused right now; then focus history. Unfocused and minimised
 * windows still qualify, because another app being in front is the normal
 * case for an attention sound. Cached, crashed and withheld views never do.
 * The target is revalidated on every send, so a closed window simply loses
 * its turn, and a send that throws falls through to the next candidate.
 *
 * Remote endpoints are other machines and each still gets its copy. Returns
 * whether a local renderer took the push.
 */
export function sendToOneVisibleRenderer(channel: string, ...args: unknown[]): boolean {
  let delivered = false;
  for (const wc of singleTargetCandidates(channel, args)) {
    try {
      wc.send(channel, ...args);
    } catch {
      continue;
    }
    singleTargetByChannel.set(channel, wc.id);
    delivered = true;
    break;
  }
  if (!delivered) singleTargetByChannel.delete(channel);
  broadcastToRemoteEndpoints(channel, args);
  return delivered;
}

/**
 * Visible-only broadcast for one-off notices a renderer turns into its own
 * per-view attention (error toasts, Problems-dock auto-open): one copy where
 * the user is looking instead of one per open project (#13711). When no
 * uncached renderer exists — a window whose views were all parked, mid
 * teardown — it falls back to every renderer, so the notice is never dropped.
 */
export function broadcastToVisibleRenderersOrAll(channel: string, ...args: unknown[]): void {
  const hasVisible = getAllAppWebContents().some(
    (wc) => !wc.isDestroyed() && !isCachedViewWebContents(wc.id)
  );
  if (hasVisible) {
    broadcastToVisibleRenderers(channel, ...args);
  } else {
    broadcastToRenderer(channel, ...args);
  }
}

/**
 * Reply to the renderer that made this call. A remote endpoint has no window,
 * so its push goes through the endpoint; a local sender with no window still
 * gets nothing, as before.
 */
export function sendToRendererContext(ctx: IpcContext, channel: string, ...args: unknown[]): void {
  if (ctx.senderWindow === null) {
    const endpoint = ctx.endpoint as ClientEndpoint | undefined;
    if (endpoint?.kind !== "remote-view" || endpoint.isClosed()) return;
    try {
      endpoint.send({ type: "event", channel, args });
    } catch {
      // Silently ignore send failures on a closing link.
    }
    return;
  }
  sendToRenderer(ctx.senderWindow, channel, ...args);
}

type InvokeRunner = (args: unknown[], run: () => unknown) => unknown;

/**
 * Wrap handler execution in the perf-capture marks. With capture disabled the
 * runner calls straight through, so synchronous handlers stay synchronous.
 */
function createInvokeRunner(channel: string): InvokeRunner {
  if (!isPerformanceCaptureEnabled()) return (_args, run) => run();
  let requestCounter = 0;
  return async (args, run) => {
    const traceId = `${channel}-${Date.now().toString(36)}-${(++requestCounter).toString(36)}`;
    const startedAt = performance.now();
    markPerformance(PERF_MARKS.IPC_REQUEST_START, {
      channel,
      traceId,
      argCount: args.length,
    });

    let responsePayload: unknown;
    let errored = false;

    try {
      responsePayload = await run();
      return responsePayload;
    } catch (error) {
      errored = true;
      throw error;
    } finally {
      const durationMs = performance.now() - startedAt;
      markPerformance(PERF_MARKS.IPC_REQUEST_END, {
        channel,
        traceId,
        durationMs,
        ok: !errored,
      });
      sampleIpcTiming(channel, durationMs, {
        traceId,
        requestPayload: args,
        responsePayload,
        errored,
      });
    }
  };
}

/**
 * Register one invoke handler with both transports: `ipcMain` for local views
 * (whose listener gets the real event) and the dispatcher for calls that
 * arrive over a link (whose listener gets a context built from the endpoint).
 */
function registerInvokeHandler(
  channel: string,
  local: (event: Electron.IpcMainInvokeEvent, args: unknown[]) => unknown,
  remote: (ctx: IpcContext, args: unknown[]) => unknown
): () => void {
  ipcMain.handle(channel, (event, ...args) => local(event, args));
  const unregister = getIpcDispatcher().registerInvoke(channel, (ctx, ...args) =>
    remote(ctx, args)
  );
  return () => {
    unregister();
    ipcMain.removeHandler(channel);
  };
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
  const run = createInvokeRunner(channel as string);
  const invoke = (args: unknown[]) => handler(...(args as IpcInvokeMap[K]["args"]));
  return registerInvokeHandler(
    channel as string,
    (_event, args) => run(args, () => invoke(args)),
    (_ctx, args) => run(args, () => invoke(args))
  );
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
  handler: (
    payload: z.output<S>
  ) =>
    | Promise<ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>>
    | ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>
): () => void {
  assertIpcSecurityReady(channel as string);
  // Wrap as async so a synchronous throw from `parseIpcPayload` always
  // surfaces as a rejected promise. `ipcMain.handle` accepts both forms in
  // production, but normalising here keeps test mocks consistent and makes
  // the contract explicit.
  const wrapped = async (
    ...args: IpcInvokeMap[K]["args"]
  ): Promise<ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>> => {
    const parsed = parseIpcPayload(channel as string, schema, args[0]);
    return handler(parsed);
  };
  return typedHandle(channel, wrapped);
}

/**
 * Build the per-request {@link IpcContext} from the sender's identity.
 *
 * The project must come from `webContentsRegistry`, whose map spans every
 * window: a `ProjectViewManager` only knows its own window's views, so
 * resolving through one would return null for every sender outside it
 * (#11100). `projectId` is legitimately null for senders with no project
 * binding — an unbound "new window" showing the project picker, or a view
 * whose project has not been registered yet — so handlers must treat it as
 * "unknown", never as "unauthorized".
 */
function buildIpcContext(event: Electron.IpcMainInvokeEvent): IpcContext {
  const webContentsId = event.sender.id;
  // Resolved on first read: most local handlers never touch the endpoint, and
  // creating one subscribes to the sender's `destroyed` event.
  let endpoint: ClientEndpoint | undefined;
  return {
    event,
    webContentsId,
    senderWindow: getWindowForWebContents(event.sender),
    projectId: getProjectForWebContents(webContentsId),
    get endpoint(): ClientEndpoint {
      endpoint ??= getLocalEndpoint(event.sender);
      return endpoint;
    },
    client: getLocalClientRef(),
  };
}

/**
 * The {@link IpcContext} for a local fire-and-forget message. Window and
 * project are resolved on first read: these listeners include the per-keystroke
 * and per-chunk-ack paths, and most never look at either.
 */
function buildSendContext(event: Electron.IpcMainEvent): IpcContext {
  const sender = event.sender;
  let senderWindow: BrowserWindow | null | undefined;
  let projectId: string | null | undefined;
  let endpoint: ClientEndpoint | undefined;
  return {
    event: event as unknown as Electron.IpcMainInvokeEvent,
    webContentsId: sender.id,
    get senderWindow(): BrowserWindow | null {
      if (senderWindow === undefined) senderWindow = getWindowForWebContents(sender);
      return senderWindow;
    },
    get projectId(): string | null {
      if (projectId === undefined) projectId = getProjectForWebContents(sender.id);
      return projectId;
    },
    get endpoint(): ClientEndpoint {
      endpoint ??= getLocalEndpoint(sender);
      return endpoint;
    },
    client: getLocalClientRef(),
  };
}

/**
 * Register a fire-and-forget listener with both transports: `ipcMain.on` for
 * local views (through the sender-validated wrapper, with a context built from
 * the event) and the dispatcher for messages that arrive over a link. A plain
 * `ipcMain.on` listener cannot serve a link send — it needs a real
 * `IpcMainEvent` — so host-side send channels register here.
 */
export function onWithContext<A extends unknown[]>(
  channel: string,
  listener: (ctx: IpcContext, ...args: A) => void
): () => void {
  assertIpcSecurityReady(channel);
  // Arguments are whatever the sender put on the wire; listeners validate them.
  const dispatch = listener as (ctx: IpcContext, ...args: unknown[]) => void;
  const local = (event: Electron.IpcMainEvent, ...args: unknown[]) => {
    dispatch(buildSendContext(event), ...args);
  };
  ipcMain.on(channel, local);
  const unregister = getIpcDispatcher().registerSend(channel, dispatch);
  return () => {
    unregister();
    ipcMain.removeListener(channel, local);
  };
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
  const run = createInvokeRunner(channel as string);
  const invoke = (ctx: IpcContext, args: unknown[]) =>
    handler(ctx, ...(args as IpcInvokeMap[K]["args"]));
  return registerInvokeHandler(
    channel as string,
    (event, args) => {
      const ctx = buildIpcContext(event);
      return run(args, () => invoke(ctx, args));
    },
    (ctx, args) => run(args, () => invoke(ctx, args))
  );
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
  ) =>
    | Promise<ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>>
    | ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>
): () => void {
  assertIpcSecurityReady(channel as string);
  // Wrap as async so synchronous parse throws become rejected promises.
  const wrapped = async (
    ctx: IpcContext,
    ...args: IpcInvokeMap[K]["args"]
  ): Promise<ForbidIpcEnvelopeKeys<IpcInvokeMap[K]["result"]>> => {
    const parsed = parseIpcPayload(channel as string, schema, args[0]);
    return handler(ctx, parsed);
  };
  return typedHandleWithContext(channel, wrapped);
}

export function typedBroadcast<K extends keyof IpcEventMap>(
  channel: K,
  payload: IpcEventMap[K]
): void {
  for (const wc of getAllAppWebContents()) {
    if (!wc.isDestroyed()) {
      if (isWithheldFromView(wc.id, channel as string, [payload])) continue;
      try {
        wc.send(channel as string, payload);
      } catch {
        // Silently ignore send failures during window initialization/disposal.
      }
    }
  }
  broadcastToRemoteEndpoints(channel as string, [payload]);
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

  if (isWithheldFromView(webContents.id, channel as string, [payload])) return;

  try {
    webContents.send(channel as string, payload);
  } catch {
    // Silently ignore send failures during window initialization/disposal.
  }
}
