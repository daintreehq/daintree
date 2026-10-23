// The one door to the terminal instance service, so its importers stop pinning
// the 4,800-line module (and the ~50 it alone pulls in) into every project
// view's boot closure. The service is imported here as a type only and built
// by load(), on the view's first terminal (#14267); register() is the seam
// tests inject a service through.
//
// load() imports the barrel because the barrel only re-exports the real file:
// a vi.mock of either path is picked up.

import type { TerminalPaintPlane } from "./TerminalInstanceService";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import { getPanelStoreSnapshot } from "@/store/storeAccessors";
import { logError } from "@/utils/logger";

type ServiceCall = (service: TerminalPaintPlane) => void;

interface QueuedCall {
  fn: ServiceCall;
  panelId?: string;
  panelExisted: boolean;
}

let instance: TerminalPaintPlane | null = null;
let loadPromise: Promise<TerminalPaintPlane> | null = null;
let queuedCalls: QueuedCall[] = [];
const readyListeners = new Set<ServiceCall>();
let pendingGpuHardwareAvailable: boolean | null = null;
// Bumped by __testing.reset() so a load or onReady delivery still in flight
// from before the reset cannot leak into the next test.
let generation = 0;

function runSafely(fn: ServiceCall, service: TerminalPaintPlane): void {
  try {
    fn(service);
  } catch (err) {
    logError("Terminal service call queued before load failed", err);
  }
}

function hasPanel(panelId: string): boolean {
  const snapshot = getPanelStoreSnapshot();
  return snapshot === null || snapshot.panelsById[panelId] !== undefined;
}

// Main samples every active view's terminal buffers (#14213) and reads a view
// that doesn't answer as unknown. Until the service exists this view has no
// terminals, so it answers for it: zero, not unknown. Armed once at renderer
// boot; the service takes both edges over once built.
let disarmUnloadedSampling: (() => void) | null = null;

function reportEmptySample(): void {
  if (instance) return;
  try {
    const report = window.electron?.system?.reportTerminalRendererDiagnostics;
    if (typeof report !== "function") return;
    void report({
      webglMode: "webgl",
      wantsWebgl: 0,
      terminalCount: 0,
      countsByTier: {},
      bufferMemory: { sampledAt: Date.now(), terminals: [] },
    }).catch(() => {
      // Fire-and-forget, like the service's own report.
    });
  } catch {
    // Best-effort diagnostics never throw into boot.
  }
}

export function answerBufferSamplesUntilLoaded(): void {
  if (instance || disarmUnloadedSampling || typeof window === "undefined") return;
  const events = window.electron?.events;
  const offRequest =
    typeof events?.on === "function"
      ? events.on("window:sample-terminal-buffers", () => {
          // Main never asks a cached view; the cache edge already answered.
          if (!isProjectViewCached()) reportEmptySample();
        })
      : null;
  const offLifecycle = subscribeProjectViewLifecycle((phase) => {
    if (phase === "cached") reportEmptySample();
  });
  disarmUnloadedSampling = () => {
    offRequest?.();
    offLifecycle();
  };
  // Cached before boot got here: that edge is gone, so report now.
  if (isProjectViewCached()) reportEmptySample();
}

function becomeReady(service: TerminalPaintPlane): void {
  if (instance) return;
  instance = service;
  disarmUnloadedSampling?.();
  disarmUnloadedSampling = null;
  if (pendingGpuHardwareAvailable !== null) {
    service.setGPUHardwareAvailable(pendingGpuHardwareAvailable);
    pendingGpuHardwareAvailable = null;
  }
  const calls = queuedCalls;
  queuedCalls = [];
  for (const call of calls) {
    // A panel closed while the service loaded has nothing left to apply to.
    if (call.panelId !== undefined && call.panelExisted && !hasPanel(call.panelId)) continue;
    runSafely(call.fn, service);
  }
  // Delete-then-run rather than clear-then-run, so a listener disposed by an
  // earlier one during this dispatch is skipped.
  for (const cb of [...readyListeners]) {
    if (readyListeners.delete(cb)) runSafely(cb, service);
  }
}

export function register(service: TerminalPaintPlane): void {
  becomeReady(service);
}

export function peek(): TerminalPaintPlane | null {
  return instance;
}

export function load(): Promise<TerminalPaintPlane> {
  if (instance) return Promise.resolve(instance);
  if (loadPromise) return loadPromise;
  const loadGeneration = generation;
  loadPromise = import("@/services/TerminalInstanceService")
    .then(({ createTerminalPaintPlane }) => {
      if (instance) return instance;
      const service = createTerminalPaintPlane();
      if (loadGeneration === generation) becomeReady(service);
      return service;
    })
    .catch((err: unknown) => {
      if (loadGeneration === generation) loadPromise = null;
      throw err;
    });
  return loadPromise;
}

// Runs now when the service is loaded, otherwise in call order once it is. For
// per-id state that must not be dropped just because no instance exists yet.
// It does not trigger a load by itself. Given the panel it acts on, a queued
// call is dropped if that panel is closed before the service arrives; one
// queued before its panel joined the store still runs.
function withService(fn: ServiceCall, panelId?: string): void {
  if (instance) {
    fn(instance);
    return;
  }
  queuedCalls.push({
    fn,
    panelId,
    panelExisted:
      panelId !== undefined && getPanelStoreSnapshot()?.panelsById[panelId] !== undefined,
  });
}
export { withService as with };

export function onReady(cb: ServiceCall): () => void {
  if (instance) {
    const service = instance;
    const readyGeneration = generation;
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed && readyGeneration === generation) runSafely(cb, service);
    });
    return () => {
      disposed = true;
    };
  }
  readyListeners.add(cb);
  return () => {
    readyListeners.delete(cb);
  };
}

// A subscription that waits for the service instead of loading it, for
// listeners owned by React (useSyncExternalStore, effects). Attaches now when
// the service is loaded; otherwise on ready, then calls `onAttachedLate` so a
// store consumer re-reads a snapshot that just stopped being its fallback. The
// returned cleanup covers both the pending wait and the attached listener.
export function subscribeWhenReady(
  attach: (service: TerminalPaintPlane) => () => void,
  onAttachedLate?: () => void
): () => void {
  if (instance) return attach(instance);
  let detach: (() => void) | null = null;
  let disposed = false;
  const cancelReady = onReady((service) => {
    if (disposed) return;
    const off = attach(service);
    // attach() itself may have disposed us; nothing else will call `off` then.
    if (disposed) {
      off();
      return;
    }
    detach = off;
    onAttachedLate?.();
  });
  return () => {
    if (disposed) return;
    disposed = true;
    cancelReady();
    detach?.();
    detach = null;
  };
}

export function setGpuHardwareAvailable(value: boolean): void {
  if (instance) {
    instance.setGPUHardwareAvailable(value);
    return;
  }
  pendingGpuHardwareAvailable = value;
}

export const __testing = {
  reset(): void {
    generation += 1;
    instance = null;
    loadPromise = null;
    queuedCalls = [];
    readyListeners.clear();
    pendingGpuHardwareAvailable = null;
    disarmUnloadedSampling?.();
    disarmUnloadedSampling = null;
  },
};
