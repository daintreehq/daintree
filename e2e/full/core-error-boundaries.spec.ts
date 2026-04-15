import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

test.describe.serial("Core: Error Boundaries", () => {
  let ctx: AppContext;

  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("error boundary catches render error and shows fallback UI", async () => {
    const { window } = ctx;

    // Arm the fault injector — next React re-render will throw
    await window.evaluate(() => {
      window.__DAINTREE_E2E_FAULT__ = { renderError: true };
    });

    // Trigger re-render of the E2EFaultInjector component
    await window.evaluate(() => {
      window.dispatchEvent(new Event("__canopy_e2e_trigger_render__"));
    });

    // Wait for the error fallback to appear
    const fallback = window.locator(SEL.errorBoundary.fallback);
    await expect(fallback).toBeVisible({ timeout: T_MEDIUM });

    // Verify fullscreen variant content
    await expect(fallback).toHaveAttribute("data-variant", "fullscreen");
    await expect(window.locator(SEL.errorBoundary.title)).toContainText("Application Error");
    await expect(window.locator(SEL.errorBoundary.restartButton)).toContainText(
      "Restart Application"
    );
    await expect(window.locator(SEL.errorBoundary.reportButton)).toBeVisible();
    await expect(window.locator(SEL.errorBoundary.logsButton)).toBeVisible();
  });

  test("Restart Application button recovers the app", async () => {
    const { window } = ctx;

    // Fallback should still be visible from previous test
    await expect(window.locator(SEL.errorBoundary.fallback)).toBeVisible({ timeout: T_SHORT });

    // Clear the fault BEFORE clicking restart, or it will re-throw immediately
    await window.evaluate(() => {
      delete window.__DAINTREE_E2E_FAULT__;
    });

    await window.locator(SEL.errorBoundary.restartButton).click();

    // Fallback should disappear
    await expect(window.locator(SEL.errorBoundary.fallback)).not.toBeVisible({
      timeout: T_LONG,
    });

    // Main UI should be restored — settings button is the standard readiness indicator
    await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible({
      timeout: T_LONG,
    });
  });

  test("unhandled promise rejection is caught and logged to error store", async () => {
    const { window } = ctx;

    // Get baseline error count
    const baselineCount = await window.evaluate(() => {
      return window.__DAINTREE_E2E_ERROR_STORE__?.().length ?? 0;
    });

    // Fire-and-forget unhandled rejection via setTimeout
    await window.evaluate(() => {
      setTimeout(() => {
        Promise.reject(new Error("e2e-unhandled-rejection-test"));
      }, 0);
    });

    // Poll until the error appears in the store
    await expect
      .poll(
        async () => {
          return window.evaluate(() => {
            const errors = window.__DAINTREE_E2E_ERROR_STORE__?.() ?? [];
            return errors.find(
              (e) =>
                e.source === "Renderer Promise Rejection" &&
                e.message.includes("e2e-unhandled-rejection-test")
            );
          });
        },
        { timeout: T_MEDIUM, message: "Expected unhandled rejection to appear in error store" }
      )
      .toBeTruthy();

    // Verify error count increased
    const newCount = await window.evaluate(() => {
      return window.__DAINTREE_E2E_ERROR_STORE__?.().length ?? 0;
    });
    expect(newCount).toBeGreaterThan(baselineCount);
  });
});
