// The one door to the terminal instance service, so its importers stop pinning
// the 4,800-line module (and the ~50 it alone pulls in) into every project
// view's boot closure. The service is imported here as a type only; the value
// arrives either through register(), which the service module calls at eval,
// or through load()'s dynamic import.
//
// load() takes the instance from the import result rather than waiting on
// register(), so a vi.mock of the service module (which never evaluates the
// real file) still resolves. It imports the barrel because the barrel only
// re-exports the real file: a mock of either path is picked up.

import type { TerminalPaintPlane } from "./TerminalInstanceService";
import { logError } from "@/utils/logger";

type ServiceCall = (service: TerminalPaintPlane) => void;

let instance: TerminalPaintPlane | null = null;
let loadPromise: Promise<TerminalPaintPlane> | null = null;
let queuedCalls: ServiceCall[] = [];
const readyListeners = new Set<ServiceCall>();
let pendingGpuHardwareAvailable: boolean | null = null;

function runSafely(fn: ServiceCall, service: TerminalPaintPlane): void {
  try {
    fn(service);
  } catch (err) {
    logError("Terminal service call queued before load failed", err);
  }
}

function becomeReady(service: TerminalPaintPlane): void {
  if (instance) return;
  instance = service;
  if (pendingGpuHardwareAvailable !== null) {
    service.setGPUHardwareAvailable(pendingGpuHardwareAvailable);
    pendingGpuHardwareAvailable = null;
  }
  const calls = queuedCalls;
  queuedCalls = [];
  for (const fn of calls) runSafely(fn, service);
  const listeners = [...readyListeners];
  readyListeners.clear();
  for (const cb of listeners) runSafely(cb, service);
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
  loadPromise = import("@/services/TerminalInstanceService")
    .then(({ terminalInstanceService }) => {
      becomeReady(terminalInstanceService);
      return instance ?? terminalInstanceService;
    })
    .catch((err: unknown) => {
      loadPromise = null;
      throw err;
    });
  return loadPromise;
}

// Runs now when the service is loaded, otherwise in call order once it is. For
// per-id state that must not be dropped just because no instance exists yet.
// It does not trigger a load by itself.
function withService(fn: ServiceCall): void {
  if (instance) {
    fn(instance);
    return;
  }
  queuedCalls.push(fn);
}
export { withService as with };

export function onReady(cb: ServiceCall): () => void {
  if (instance) {
    const service = instance;
    let disposed = false;
    queueMicrotask(() => {
      if (!disposed) runSafely(cb, service);
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

export function setGpuHardwareAvailable(value: boolean): void {
  if (instance) {
    instance.setGPUHardwareAvailable(value);
    return;
  }
  pendingGpuHardwareAvailable = value;
}

export const __testing = {
  reset(): void {
    instance = null;
    loadPromise = null;
    queuedCalls = [];
    readyListeners.clear();
    pendingGpuHardwareAvailable = null;
  },
};
