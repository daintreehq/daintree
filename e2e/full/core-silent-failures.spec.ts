import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { injectFault, clearAllFaults } from "../helpers/ipcFaults";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";

import { openSettings, openTerminal } from "../helpers/panels";
let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Silent IPC Failure Detection", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "silent-failures" });
    ctx = await launchApp({ env: { CANOPY_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Silent Failures");
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("GitHub issues dropdown shows error state on IPC fault", async () => {
    await injectFault(ctx.app, "github:list-issues", "E2E_INJECTED_ERROR");

    const issuesButton = ctx.window.locator('button[aria-label*="open issues"]');
    await expect(issuesButton).toBeVisible({ timeout: T_MEDIUM });
    await issuesButton.click();

    const retryButton = ctx.window.locator('button:has-text("Retry")');
    await expect(retryButton).toBeVisible({ timeout: T_MEDIUM });

    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).not.toBeVisible();

    await ctx.window.keyboard.press("Escape");
  });

  test("diagnostics dock continues working when persistence fails", async () => {
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await ctx.window.keyboard.press(`${mod}+Shift+D`);

    const dock = ctx.window.locator(SEL.diagnostics.dock);
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });

    await injectFault(ctx.app, "app:set-state", "E2E_INJECTED_ERROR");

    const resizeHandle = ctx.window.locator(SEL.diagnostics.resizeHandle);
    await resizeHandle.focus();
    await ctx.window.keyboard.press("ArrowUp");

    await ctx.window.waitForTimeout(T_SETTLE);

    await expect(dock).toBeVisible();
    await expect(ctx.window.locator(SEL.toolbar.openSettings)).toBeVisible();
    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).not.toBeVisible();

    await clearAllFaults(ctx.app);

    const closeButton = ctx.window.locator(SEL.diagnostics.closeButton);
    await closeButton.click();
    await expect(dock).not.toBeVisible({ timeout: T_SHORT });
  });

  test("settings persist gracefully when state write fails", async () => {
    await openSettings(ctx.window);
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    const troubleshootingTab = ctx.window.locator('button:has-text("Troubleshooting")');
    await troubleshootingTab.click();

    const devModeToggle = ctx.window.locator('[aria-label="Developer Mode Toggle"]');
    await devModeToggle.scrollIntoViewIfNeeded();
    await expect(devModeToggle).toBeVisible({ timeout: T_MEDIUM });

    await injectFault(ctx.app, "app:set-state", "E2E_INJECTED_ERROR");

    await devModeToggle.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible();
    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).not.toBeVisible();

    await clearAllFaults(ctx.app);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await expect(ctx.window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  test("app survives terminal spawn fault without crashing", async () => {
    await injectFault(ctx.app, "terminal:spawn", "E2E_INJECTED_ERROR");

    await openTerminal(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).not.toBeVisible();

    const settingsButton = ctx.window.locator(SEL.toolbar.openSettings);
    await expect(settingsButton).toBeVisible();
    await expect(settingsButton).toBeEnabled();

    await clearAllFaults(ctx.app);
  });
});
