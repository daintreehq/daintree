export interface FaultErrorConfig {
  kind: "error";
  message: string;
  code?: string;
}

export interface FaultDelayConfig {
  kind: "delay";
  delayMs: number;
}

export type FaultConfig = FaultErrorConfig | FaultDelayConfig;

declare global {
  var __canopyFaultRegistry: Record<string, FaultConfig> | undefined;
}

export const FAULT_MODE_ENABLED = process.env.DAINTREE_E2E_FAULT_MODE === "1";

function ensureRegistry(): Record<string, FaultConfig> {
  if (!globalThis.__canopyFaultRegistry) {
    globalThis.__canopyFaultRegistry = {};
  }
  return globalThis.__canopyFaultRegistry;
}

export function initFaultRegistry(): void {
  if (!FAULT_MODE_ENABLED) return;
  ensureRegistry();
}

export function getFault(channel: string): FaultConfig | undefined {
  if (!FAULT_MODE_ENABLED) return undefined;
  return globalThis.__canopyFaultRegistry?.[channel];
}

export function setFault(channel: string, config: FaultConfig): void {
  if (!FAULT_MODE_ENABLED) return;
  ensureRegistry()[channel] = config;
}

export function clearFault(channel: string): void {
  if (!FAULT_MODE_ENABLED) return;
  const registry = globalThis.__canopyFaultRegistry;
  if (registry) delete registry[channel];
}

export function clearAllFaults(): void {
  if (!FAULT_MODE_ENABLED) return;
  globalThis.__canopyFaultRegistry = {};
}

export async function applyInvokeFault(channel: string): Promise<void> {
  if (!FAULT_MODE_ENABLED) return;
  const fault = globalThis.__canopyFaultRegistry?.[channel];
  if (!fault) return;

  if (fault.kind === "delay") {
    await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    return;
  }

  const error = new Error(fault.message);
  if (fault.code) {
    (error as NodeJS.ErrnoException).code = fault.code;
  }
  throw error;
}
