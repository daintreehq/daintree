import { test, expect } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const FIRST_RUN_ENV = { CANOPY_E2E_SKIP_FIRST_RUN_DIALOGS: "0" };

test.describe.serial("First-run onboarding flow", () => {
  let userDataDir: string;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "canopy-e2e-first-run-"));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test("completes onboarding wizard on first launch", async () => {
    ctx = await launchApp({
      userDataDir,
      env: FIRST_RUN_ENV,
      waitForSelector: SEL.firstRun.themeTitle,
    });
    const { window } = ctx;

    // Step 1: Theme selection — verify dialog and click Continue
    await expect(window.locator(SEL.firstRun.themeTitle)).toBeVisible({ timeout: T_MEDIUM });
    await window.locator('button:has-text("Continue")').click();

    // Step 2: Telemetry consent — verify dialog and click Disable
    await expect(window.locator(SEL.firstRun.telemetryDialog)).toBeVisible({ timeout: T_MEDIUM });
    await window
      .locator(SEL.firstRun.telemetryDialog)
      .locator('button:has-text("Disable")')
      .click();

    // Step 3: Agent selection — verify dialog and click Skip
    await expect(window.locator(SEL.firstRun.agentTitle)).toBeVisible({ timeout: T_MEDIUM });
    await window.locator('button:has-text("Skip")').click();

    // Onboarding complete — toolbar should become visible
    await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible({ timeout: T_MEDIUM });

    // Clean close for persistence
    const pid = ctx.app.process().pid!;
    await closeApp(ctx.app);
    await waitForProcessExit(pid);
    ctx = null;
  });

  test("does not show onboarding on second launch", async () => {
    ctx = await launchApp({
      userDataDir,
      env: FIRST_RUN_ENV,
    });
    const { window } = ctx;

    // App should load directly to toolbar without onboarding
    await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible({ timeout: T_MEDIUM });

    // Allow onboarding hydration to complete before asserting absence
    await window.waitForTimeout(T_SETTLE);

    // No onboarding dialogs should be visible
    await expect(window.locator(SEL.firstRun.themeTitle)).not.toBeVisible();
    await expect(window.locator(SEL.firstRun.telemetryDialog)).not.toBeVisible();
    await expect(window.locator(SEL.firstRun.agentTitle)).not.toBeVisible();
    await expect(window.locator(SEL.firstRun.agentSetupTitle)).not.toBeVisible();
  });
});
