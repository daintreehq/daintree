import { store } from "../../store.js";
import type { DeviceAnswerService } from "./DeviceAnswerService.js";

/**
 * The service is made on first use: at boot only when the setting is on, or
 * when Settings asks. Until then nothing of it is loaded, so the feature
 * costs nothing for anyone who never turns it on.
 */
let service: DeviceAnswerService | null = null;
let creating: Promise<DeviceAnswerService> | null = null;

export function peekDeviceAnswerService(): DeviceAnswerService | null {
  return service;
}

export function getDeviceAnswerService(): Promise<DeviceAnswerService> {
  creating ??= (async () => {
    const { createDeviceAnswerService } = await import("./createDeviceAnswerService.js");
    service = createDeviceAnswerService();
    return service;
  })();
  return creating;
}

/** Boot: start the listener only if the user left it on. */
export async function startDeviceAnswerIfEnabled(): Promise<void> {
  if (store.get("deviceAnswer")?.enabled !== true) return;
  const next = await getDeviceAnswerService();
  await next.init();
}

/** Quit: close the listener and every connection on it. */
export async function stopDeviceAnswer(): Promise<void> {
  await service?.dispose();
}

/** @internal Tests only. */
export function _resetDeviceAnswerServiceForTesting(): void {
  service = null;
  creating = null;
}
