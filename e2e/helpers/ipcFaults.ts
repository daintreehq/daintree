import type { ElectronApplication, Page } from "@playwright/test";

/**
 * Inject an error fault on the given IPC channel.
 * Next invoke on this channel will throw with the provided message/code.
 */
export async function injectFault(
  app: ElectronApplication,
  channel: string,
  message: string,
  code?: string
): Promise<void> {
  await app.evaluate(
    (_modules, { channel, message, code }) => {
      const registry = globalThis.__daintreeFaultRegistry;
      if (!registry)
        throw new Error("Fault mode not enabled — launch with DAINTREE_E2E_FAULT_MODE=1");
      registry[channel] = { kind: "error", message, ...(code ? { code } : {}) };
    },
    { channel, message, code }
  );
}

/**
 * Inject a delay fault on the given IPC channel.
 * Next invoke on this channel will be delayed by delayMs before executing.
 */
export async function injectDelay(
  app: ElectronApplication,
  channel: string,
  delayMs: number
): Promise<void> {
  await app.evaluate(
    (_modules, { channel, delayMs }) => {
      const registry = globalThis.__daintreeFaultRegistry;
      if (!registry)
        throw new Error("Fault mode not enabled — launch with DAINTREE_E2E_FAULT_MODE=1");
      registry[channel] = { kind: "delay", delayMs };
    },
    { channel, delayMs }
  );
}

/** Clear the fault for a single IPC channel. */
export async function clearFault(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate((_modules, ch) => {
    const registry = globalThis.__daintreeFaultRegistry;
    if (registry) delete registry[ch];
  }, channel);
}

/** Clear all injected faults. */
export async function clearAllFaults(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    if (globalThis.__daintreeFaultRegistry) {
      globalThis.__daintreeFaultRegistry = {};
    }
  });
}

/**
 * Check whether a handle-based handler is registered for the given channel.
 * Returns `true`/`false`, or `null` if the internal API is unavailable.
 */
export async function getHandlerCount(
  app: ElectronApplication,
  channel: string
): Promise<boolean | null> {
  return app.evaluate(({ ipcMain }, ch) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private Electron API
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, unknown> | undefined;
    if (!handlers) return null;
    return handlers.has(ch);
  }, channel);
}

/** Get the number of ipcMain.on/once listeners for the given channel. */
export async function getListenerCount(app: ElectronApplication, channel: string): Promise<number> {
  return app.evaluate(({ ipcMain }, ch) => {
    return ipcMain.listenerCount(ch);
  }, channel);
}

/**
 * Get the total number of ipcMain.handle() handlers registered.
 * Returns `null` if the private `_invokeHandlers` API is unavailable.
 */
export async function getTotalHandlerCount(app: ElectronApplication): Promise<number | null> {
  return app.evaluate(({ ipcMain }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private Electron API
    const handlers = (ipcMain as any)._invokeHandlers as Map<string, unknown> | undefined;
    return handlers?.size ?? null;
  });
}

/**
 * Snapshot listener counts for a set of ipcMain.on() channels.
 * Returns a record mapping channel name → listener count.
 */
export async function getMainListenerSnapshot(
  app: ElectronApplication,
  channels: string[]
): Promise<Record<string, number>> {
  return app.evaluate(({ ipcMain }, chs) => {
    const snap: Record<string, number> = {};
    for (const ch of chs) snap[ch] = ipcMain.listenerCount(ch);
    return snap;
  }, channels);
}

/**
 * Get total listener count across a set of ipcMain.on() channels.
 */
export async function getTotalMainListeners(
  app: ElectronApplication,
  channels: string[]
): Promise<number> {
  return app.evaluate(({ ipcMain }, chs) => {
    let total = 0;
    for (const ch of chs) total += ipcMain.listenerCount(ch);
    return total;
  }, channels);
}

/**
 * Snapshot renderer-side ipcRenderer listener counts for a set of channels.
 * Requires the app to be launched with DAINTREE_E2E_FAULT_MODE=1.
 */
export async function getRendererListenerSnapshot(
  window: Page,
  channels: string[]
): Promise<Record<string, number>> {
  return window.evaluate((chs) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- E2E test bridge
    const bridge = (window as any).__DAINTREE_E2E_IPC__;
    if (!bridge)
      throw new Error("E2E IPC bridge not available — launch with DAINTREE_E2E_FAULT_MODE=1");
    const snap: Record<string, number> = {};
    for (const ch of chs) snap[ch] = bridge.getRendererListenerCount(ch);
    return snap;
  }, channels);
}

/** Get main-process memory usage snapshot. */
export async function getMemoryUsage(app: ElectronApplication): Promise<NodeJS.MemoryUsage> {
  return app.evaluate(() => process.memoryUsage());
}
