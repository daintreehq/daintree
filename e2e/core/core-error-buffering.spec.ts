/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { T_MEDIUM } from "../helpers/timeouts";

/* ---------- helpers ---------- */

let errorSeq = 0;

interface ErrorPayload {
  id: string;
  timestamp: number;
  type: string;
  message: string;
  isTransient: boolean;
  dismissed: boolean;
}

function buildError(overrides: Partial<ErrorPayload> = {}): ErrorPayload {
  errorSeq += 1;
  return {
    id: `e2e-buf-${Date.now()}-${errorSeq}`,
    timestamp: Date.now(),
    type: "unknown",
    message: `E2E buffered error ${errorSeq}`,
    isTransient: false,
    dismissed: false,
    ...overrides,
  };
}

async function bufferErrors(app: ElectronApplication, errors: ErrorPayload[]): Promise<void> {
  await app.evaluate(({}, errs) => {
    const svc = (globalThis as any).__canopyErrorService;
    if (!svc) throw new Error("__canopyErrorService not available");
    for (const err of errs) {
      svc.pendingQueue.push(err);
    }
  }, errors);
}

async function flushBufferedErrors(app: ElectronApplication): Promise<void> {
  await app.evaluate(({}) => {
    const svc = (globalThis as any).__canopyErrorService;
    if (!svc) throw new Error("__canopyErrorService not available");
    svc.flushPendingErrors();
  });
}

async function getErrorStoreErrors(window: Page): Promise<Array<{ id: string; message: string }>> {
  return window.evaluate(() => {
    return (window as any).__CANOPY_E2E_ERROR_STORE__?.() ?? [];
  });
}

async function clearErrorsAndCloseDock(window: Page) {
  const dock = window.locator('[aria-label="Diagnostics dock"]');
  if (await dock.isVisible().catch(() => false)) {
    const clearButton = window.locator('button:has-text("Clear All")');
    if (await clearButton.isVisible().catch(() => false)) {
      if (await clearButton.isEnabled().catch(() => false)) {
        await clearButton.click();
      }
    }
    const closeBtn = window.locator('[aria-label="Close diagnostics dock"]');
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    }
  }
  await window.waitForTimeout(200);
}

/* ---------- tests ---------- */

let ctx: AppContext;

test.describe.serial("Core: Error Buffering Flush", () => {
  test.beforeAll(async () => {
    ctx = await launchApp({ env: { CANOPY_E2E_FAULT_MODE: "1" } });
  });

  test.afterEach(async () => {
    await clearErrorsAndCloseDock(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("single buffered error is flushed to the renderer", async () => {
    const error = buildError({ message: "Buffered single error test" });
    await bufferErrors(ctx.app, [error]);
    await flushBufferedErrors(ctx.app);

    await expect
      .poll(
        async () => {
          const errors = await getErrorStoreErrors(ctx.window);
          return errors.length;
        },
        { timeout: T_MEDIUM, message: "Expected 1 buffered error to flush" }
      )
      .toBeGreaterThanOrEqual(1);

    const errors = await getErrorStoreErrors(ctx.window);
    expect(errors.some((e) => e.message === "Buffered single error test")).toBe(true);
  });

  test("multiple buffered errors all flush to the renderer", async () => {
    const errors = [
      buildError({ message: "Multi-buffer error alpha" }),
      buildError({ message: "Multi-buffer error beta" }),
      buildError({ message: "Multi-buffer error gamma" }),
    ];

    await bufferErrors(ctx.app, errors);
    await flushBufferedErrors(ctx.app);

    await expect
      .poll(
        async () => {
          const store = await getErrorStoreErrors(ctx.window);
          return store.length;
        },
        { timeout: T_MEDIUM, message: "Expected 3 buffered errors to flush" }
      )
      .toBeGreaterThanOrEqual(3);

    const store = await getErrorStoreErrors(ctx.window);
    expect(store.some((e) => e.message === "Multi-buffer error alpha")).toBe(true);
    expect(store.some((e) => e.message === "Multi-buffer error beta")).toBe(true);
    expect(store.some((e) => e.message === "Multi-buffer error gamma")).toBe(true);
  });
});
