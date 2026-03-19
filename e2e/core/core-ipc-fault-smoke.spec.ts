/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import {
  injectFault,
  injectDelay,
  clearFault,
  clearAllFaults,
  getHandlerCount,
  getListenerCount,
  getMemoryUsage,
} from "../helpers/ipcFaults";

let ctx: AppContext;

test.describe.serial("Core: IPC Fault Injection Smoke", () => {
  test.beforeAll(async () => {
    ctx = await launchApp({ env: { CANOPY_E2E_FAULT_MODE: "1" } });
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("fault registry is initialized", async () => {
    const registryExists = await ctx.app.evaluate(() => {
      return globalThis.__canopyFaultRegistry !== undefined;
    });
    expect(registryExists).toBe(true);
  });

  test("getHandlerCount reports registered handler", async () => {
    const hasHandler = await getHandlerCount(ctx.app, "app:get-version");
    // Either true (handler found) or null (private API unavailable)
    expect(hasHandler === true || hasHandler === null).toBe(true);
  });

  test("getListenerCount returns a number", async () => {
    const count = await getListenerCount(ctx.app, "app:get-version");
    expect(typeof count).toBe("number");
  });

  test("getMemoryUsage returns valid snapshot", async () => {
    const mem = await getMemoryUsage(ctx.app);
    expect(mem.heapUsed).toBeGreaterThan(0);
    expect(mem.rss).toBeGreaterThan(0);
  });

  test("injected error fault propagates to renderer", async () => {
    await injectFault(ctx.app, "app:get-version", "E2E_INJECTED_ERROR", "E2E_FAULT");

    const result = await ctx.window.evaluate(async () => {
      try {
        await (window as any).electron.app.getVersion();
        return { threw: false };
      } catch (err: any) {
        return { threw: true, message: err.message, code: err.code };
      }
    });

    expect(result.threw).toBe(true);
    expect(result.message).toBe("E2E_INJECTED_ERROR");
    expect(result.code).toBe("E2E_FAULT");
  });

  test("clearing fault restores normal behavior", async () => {
    await injectFault(ctx.app, "app:get-version", "SHOULD_BE_CLEARED");
    await clearFault(ctx.app, "app:get-version");

    const version = await ctx.window.evaluate(async () => {
      return await (window as any).electron.app.getVersion();
    });

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("injected delay fault adds latency", async () => {
    test.slow();
    const delayMs = 500;
    await injectDelay(ctx.app, "app:get-version", delayMs);

    const start = Date.now();
    const version = await ctx.window.evaluate(async () => {
      return await (window as any).electron.app.getVersion();
    });
    const elapsed = Date.now() - start;

    // Delay should add at least 300ms (generous tolerance for CI)
    expect(elapsed).toBeGreaterThanOrEqual(300);
    // The call should still succeed after the delay
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("clearAllFaults removes all faults", async () => {
    await injectFault(ctx.app, "app:get-version", "FAULT_A");
    await injectFault(ctx.app, "app:get-state", "FAULT_B");
    await clearAllFaults(ctx.app);

    const version = await ctx.window.evaluate(async () => {
      return await (window as any).electron.app.getVersion();
    });
    expect(version).toMatch(/^\d+\.\d+\.\d+/);

    // app:get-state should also work normally
    const state = await ctx.window.evaluate(async () => {
      try {
        await (window as any).electron.app.getState();
        return { ok: true };
      } catch {
        return { ok: false };
      }
    });
    expect(state.ok).toBe(true);
  });
});
