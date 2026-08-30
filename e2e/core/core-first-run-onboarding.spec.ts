import { test, expect } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../helpers/launch";
import { removePathSync } from "../helpers/fixtures";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import { openSettings } from "../helpers/panels";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const FIRST_RUN_ENV = { DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS: "0" };

async function verifySettingsAccessible(window: AppContext["window"]): Promise<void> {
  await openSettings(window, T_MEDIUM);
  await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  await window.locator(SEL.settings.closeButton).click();
  await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_MEDIUM });
}

test.describe.serial("First-run onboarding flow", () => {
  let userDataDir: string;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-first-run-"));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
  });

  test("welcome screen is non-blocking on first launch and agent setup is opt-in", async () => {
    await test.step("Launch with first-run env and verify welcome screen + interactive toolbar", async () => {
      ctx = await launchApp({
        userDataDir,
        env: FIRST_RUN_ENV,
        waitForSelector: SEL.firstRun.welcomeTitle,
      });
      const { window } = ctx;

      // The welcome screen should render and the toolbar should be interactive
      // simultaneously — no blocking modal prevents access to the app.
      await expect(window.locator(SEL.firstRun.welcomeTitle)).toBeVisible({ timeout: T_MEDIUM });
      await verifySettingsAccessible(window);
    });

    await test.step("Verify wizard does not auto-open and banner is visible", async () => {
      const { window } = ctx!;

      // The wizard must NOT auto-open — it is opt-in via the banner CTA.
      await expect(window.locator(SEL.firstRun.agentSetupDialog)).not.toBeVisible();

      // The setup banner is visible and invites the user in.
      await expect(window.locator(SEL.firstRun.agentSetupBanner)).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    await test.step("Open wizard via banner CTA, then skip and verify dismissal", async () => {
      const { window } = ctx!;

      // Clicking the banner CTA opens the wizard on demand.
      await window.locator(SEL.firstRun.agentSetupBannerCta).click();
      await expect(window.locator(SEL.firstRun.agentSetupDialog)).toBeVisible({
        timeout: T_MEDIUM,
      });

      // Skip closes the wizard and the toolbar remains interactive.
      await window.getByTestId("agent-setup-exit").click();
      await expect(window.locator(SEL.firstRun.agentSetupDialog)).not.toBeVisible({
        timeout: T_SETTLE,
      });
      await verifySettingsAccessible(window);
    });

    await test.step("Close app cleanly to persist onboarding state for the next test", async () => {
      const pid = ctx!.app.process().pid!;
      await closeApp(ctx!.app);
      await waitForProcessExit(pid);
      ctx = null;
    });
  });

  test("second launch does not reshow the banner or auto-open the wizard", async () => {
    await test.step("Relaunch with same userDataDir and confirm toolbar is ready", async () => {
      ctx = await launchApp({
        userDataDir,
        env: FIRST_RUN_ENV,
      });
      const { window } = ctx;

      // Settings remains reachable after the first-run state has persisted.
      await verifySettingsAccessible(window);

      // Allow onboarding hydration to complete.
      await window.waitForTimeout(T_SETTLE);
    });

    await test.step("Verify first-run banner and wizard remain hidden", async () => {
      const { window } = ctx!;

      // The first-run banner must NOT reappear: the user completed the wizard
      // on first launch, which persists the onboarding-complete flag.
      await expect(window.locator(SEL.firstRun.agentSetupBanner)).not.toBeVisible();

      // The wizard must not auto-open either — the old returning-user
      // auto-open effect is gone.
      await expect(window.locator(SEL.firstRun.agentSetupDialog)).not.toBeVisible();
    });
  });
});
