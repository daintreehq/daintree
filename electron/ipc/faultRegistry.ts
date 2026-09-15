import { isE2EFaultMode } from "../setup/runtimeFlags.js";

export interface FaultErrorConfig {
  kind: "error";
  message: string;
  code?: string;
}

export interface FaultDelayConfig {
  kind: "delay";
  delayMs: number;
}

/**
 * Answer the channel with a fixed value instead of running its handler. Lets a capture
 * harness photograph a state the host machine does not happen to be in — an agent roster
 * with every availability state present at once, say — without mocking anything above the
 * IPC boundary, so the real hook, store and component still run on top of it.
 *
 * `delayMs` delays the stubbed answer the way `FaultDelayConfig` delays a real one, which
 * is what makes a "still detecting" state hold still long enough to photograph.
 */
export interface FaultStubConfig {
  kind: "stub";
  value: unknown;
  delayMs?: number;
}

export type FaultConfig = FaultErrorConfig | FaultDelayConfig | FaultStubConfig;

/** A stubbed answer. `undefined` means the real handler should run. */
export interface StubbedInvoke {
  value: unknown;
}

declare global {
  var __daintreeFaultRegistry: Record<string, FaultConfig> | undefined;
}

export const FAULT_MODE_ENABLED = isE2EFaultMode;

function ensureRegistry(): Record<string, FaultConfig> {
  if (!globalThis.__daintreeFaultRegistry) {
    globalThis.__daintreeFaultRegistry = {};
  }
  return globalThis.__daintreeFaultRegistry;
}

export function initFaultRegistry(): void {
  if (!FAULT_MODE_ENABLED) return;
  ensureRegistry();
}

export function getFault(channel: string): FaultConfig | undefined {
  if (!FAULT_MODE_ENABLED) return undefined;
  return globalThis.__daintreeFaultRegistry?.[channel];
}

export function setFault(channel: string, config: FaultConfig): void {
  if (!FAULT_MODE_ENABLED) return;
  ensureRegistry()[channel] = config;
}

export function clearFault(channel: string): void {
  if (!FAULT_MODE_ENABLED) return;
  const registry = globalThis.__daintreeFaultRegistry;
  if (registry) delete registry[channel];
}

export function clearAllFaults(): void {
  if (!FAULT_MODE_ENABLED) return;
  globalThis.__daintreeFaultRegistry = {};
}

/**
 * Apply whatever fault is registered for `channel`. Throws for an error fault, waits for a
 * delay fault, and returns a `StubbedInvoke` for a stub fault — the caller must return that
 * value instead of invoking the real handler. `undefined` means carry on as normal.
 */
export async function applyInvokeFault(channel: string): Promise<StubbedInvoke | undefined> {
  if (!FAULT_MODE_ENABLED) return undefined;
  const fault = globalThis.__daintreeFaultRegistry?.[channel];
  if (!fault) return undefined;

  if (fault.kind === "delay") {
    await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    return undefined;
  }

  if (fault.kind === "stub") {
    if (fault.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    }
    return { value: fault.value };
  }

  const error = new Error(fault.message);
  if (fault.code) {
    (error as NodeJS.ErrnoException).code = fault.code;
  }
  throw error;
}
