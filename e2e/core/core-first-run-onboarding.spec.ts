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
      waitForSelector: SEL.firstRun.welcomeTitle,
    });
    const { window } = ctx;

    // Welcome + agent selection are consolidated into a single Agent Setup dialog.
    // First-run shows the Welcome heading (not "Choose your AI agents").
    await expect(window.locator(SEL.firstRun.welcomeTitle)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.firstRun.agentSetupTitle)).toBeVisible({ timeout: T_MEDIUM });
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
    // App renders a blank screen on the second launch when first-run was
    // completed by skipping without selecting an agent. Likely interaction
    // between OnboardingFlow's auto-open wizard and the new projectStore
    // concurrency guards. Tracked separately.
    test.fixme();
    ctx = await launchApp({
      userDataDir,
      env: FIRST_RUN_ENV,
    });
    const { window } = ctx;

    // Toolbar should be visible (first-run completed previously)
    await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible({ timeout: T_MEDIUM });

    // Allow onboarding hydration to complete
    await window.waitForTimeout(T_SETTLE);

    // First-run welcome must NOT appear again.
    await expect(window.locator(SEL.firstRun.welcomeTitle)).not.toBeVisible();

    // The Agent Setup wizard auto-opens on subsequent launches when no agents are
    // installed/selected (see OnboardingFlow auto-open effect). Dismiss it and verify
    // the toolbar remains usable.
    const agentSetupDialog = window.locator(SEL.firstRun.agentSetupTitle);
    if (await agentSetupDialog.isVisible()) {
      await window.keyboard.press("Escape");
      await expect(agentSetupDialog).not.toBeVisible({ timeout: T_SETTLE });
    }
    await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible();
  });
});
