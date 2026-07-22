/* eslint-disable @typescript-eslint/no-explicit-any -- window globals are untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import {
  launchApp,
  closeApp,
  openSecondWindow,
  getWindowPage,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepos } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_LONG } from "../../helpers/timeouts";

// Verifies per-window store isolation. Each project opens in its own
// WebContentsView with an independent V8 context, so the renderer Zustand
// singletons (errorStore, diagnosticsStore, perfMetricsStore,
// performanceModeStore) are per-window — a mutation in one window must not leak
// into another. The contrast case is the watchdog-disabled broadcast, which is
// INTENTIONALLY shared: it reaches every window via an EVENTS_PUSH fan-out, not
// module-level state, so seeing it in both windows is correct, not a leak.

let ctx: AppContext;
let pageA: Page;
let pageB: Page;
let fixtureCleanups: Array<() => void> = [];

async function waitForE2EAccessors(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            typeof (window as any).__DAINTREE_E2E_PERF_MODE_STATE__ === "function" &&
            typeof (window as any).__DAINTREE_E2E_DIAGNOSTICS_STATE__ === "function"
        ),
      { timeout: T_LONG, intervals: [200, 400, 800] }
    )
    .toBe(true);
}

test.describe.serial("Resilience: multi-window store isolation", () => {
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const fixtures = createFixtureRepos(2);
    fixtureCleanups = fixtures.map((f) => f.cleanup);
    const [repoA, repoB] = fixtures.map((f) => f.dir);

    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    pageA = await openAndOnboardProject(ctx.app, ctx.window, repoA, "window-A");
    ctx.window = pageA;

    const handle = await openSecondWindow(ctx.app, pageA, { projectPath: repoB });
    pageB = await getWindowPage(ctx.app, handle.windowId);

    await waitForE2EAccessors(pageA);
    await waitForE2EAccessors(pageB);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups) cleanup();
  });

  test("errorStore mutations stay scoped to the originating window", async () => {
    await pageA.evaluate(() => (window as any).__DAINTREE_E2E_CLEAR_ERRORS__?.());
    await pageB.evaluate(() => (window as any).__DAINTREE_E2E_CLEAR_ERRORS__?.());

    await pageA.evaluate(() => (window as any).__DAINTREE_E2E_ADD_ERROR__?.("isolation-probe-A"));

    const aErrors = await pageA.evaluate(
      () => (window as any).__DAINTREE_E2E_ERROR_STORE__?.() ?? []
    );
    const bErrors = await pageB.evaluate(
      () => (window as any).__DAINTREE_E2E_ERROR_STORE__?.() ?? []
    );

    expect(aErrors.some((e: { message: string }) => e.message === "isolation-probe-A")).toBe(true);
    expect(bErrors.some((e: { message: string }) => e.message === "isolation-probe-A")).toBe(false);
  });

  test("diagnostics dock open state is scoped to the originating window", async () => {
    await pageA.evaluate(() => (window as any).__DAINTREE_E2E_OPEN_DIAGNOSTICS__?.());

    const aOpen = await pageA.evaluate(
      () => (window as any).__DAINTREE_E2E_DIAGNOSTICS_STATE__?.().isOpen ?? null
    );
    const bOpen = await pageB.evaluate(
      () => (window as any).__DAINTREE_E2E_DIAGNOSTICS_STATE__?.().isOpen ?? null
    );

    expect(aOpen).toBe(true);
    expect(bOpen).toBe(false);
  });

  test("perfMetricsStore live metrics are scoped to the originating window", async () => {
    await pageA.evaluate(() => (window as any).__DAINTREE_E2E_SET_PERF_METRIC__?.(42));

    const aFps = await pageA.evaluate(
      () => (window as any).__DAINTREE_E2E_PERF_METRICS_STATE__?.().fps ?? null
    );
    const bFps = await pageB.evaluate(
      () => (window as any).__DAINTREE_E2E_PERF_METRICS_STATE__?.().fps ?? null
    );

    expect(aFps).toBe(42);
    expect(bFps).not.toBe(42);
  });

  test("performance-mode toggle is scoped to the originating window", async () => {
    await pageA.evaluate(() => (window as any).__DAINTREE_E2E_SET_PERF_MODE__?.(true));

    const aMode = await pageA.evaluate(
      () => (window as any).__DAINTREE_E2E_PERF_MODE_STATE__?.().performanceMode ?? null
    );
    const bMode = await pageB.evaluate(
      () => (window as any).__DAINTREE_E2E_PERF_MODE_STATE__?.().performanceMode ?? null
    );

    expect(aMode).toBe(true);
    expect(bMode).toBe(false);
  });

  test("watchdog-disabled is intentionally broadcast to every window", async () => {
    // The contrast case: a genuinely app-wide signal must reach BOTH windows.
    // This is fan-out via EVENTS_PUSH, not leaked module state — so seeing the
    // banner in both windows is the correct behavior, the inverse of the
    // per-window store assertions above.
    await ctx.app.evaluate(() => {
      const fn = (globalThis as Record<string, unknown>).__daintreeSimulateWatchdogDisabled as
        (() => void) | undefined;
      if (!fn) throw new Error("__daintreeSimulateWatchdogDisabled not present");
      fn();
    });

    await expect(pageA.locator(SEL.recovery.watchdogDisabledBanner)).toBeVisible({
      timeout: T_LONG,
    });
    await expect(pageB.locator(SEL.recovery.watchdogDisabledBanner)).toBeVisible({
      timeout: T_LONG,
    });
  });
});
