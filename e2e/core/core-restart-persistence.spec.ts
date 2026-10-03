import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../helpers/launch";
import { createFixtureRepo, removePathSync } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { openSettings } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";

/**
 * One restart journey on a single userData: first-run onboarding, a setting,
 * and a project all have to survive a real quit and relaunch.
 *
 * Three sessions rather than two because the setup banner only renders on the
 * welcome screen, and a remembered project replaces the welcome screen on
 * relaunch — so "the banner stays gone" has to be checked on a relaunch that
 * still has no project, before the project is onboarded.
 */

const FIRST_RUN_ENV = { DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS: "0" };
const PROJECT_NAME = "persistence-test";

let userDataDir: string;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let ctx: AppContext | null = null;

async function verifySettingsAccessible(window: Page): Promise<void> {
  await openSettings(window, T_MEDIUM);
  await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  await window.locator(SEL.settings.closeButton).click();
  await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_MEDIUM });
}

async function openPanelGridSettings(window: Page) {
  await openSettings(window);
  await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  await window.locator(`${SEL.settings.navSidebar} button:has-text("Panel Grid")`).click();
  const toggle = window.locator(SEL.settings.performanceModeToggle);
  await toggle.scrollIntoViewIfNeeded();
  return toggle;
}

/** The footer link WelcomeScreen shows once onboarding has hydrated as answered. */
function setUpAgentsLink(window: Page) {
  return window.getByRole("button", { name: "Set up agents", exact: true });
}

async function quit(): Promise<void> {
  const pid = ctx!.app.process().pid!;
  await closeApp(ctx!.app);
  await waitForProcessExit(pid);
  ctx = null;
}

test.describe.serial("Core: onboarding, settings and project survive restart", () => {
  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-restart-"));
    const fixture = createFixtureRepo({ name: PROJECT_NAME });
    fixtureDir = fixture.dir;
    fixtureCleanup = fixture.cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
    fixtureCleanup?.();
  });

  test("session 1: first run is non-blocking, agent setup is opt-in, and a setting is changed", async () => {
    ctx = await launchApp({
      userDataDir,
      env: FIRST_RUN_ENV,
      waitForSelector: SEL.firstRun.welcomeTitle,
    });
    const { window } = ctx;

    await test.step("welcome screen renders with the toolbar usable", async () => {
      // No blocking modal: settings is reachable while the welcome screen shows.
      await expect(window.locator(SEL.firstRun.welcomeTitle)).toBeVisible({ timeout: T_MEDIUM });
      await verifySettingsAccessible(window);
    });

    await test.step("the wizard does not auto-open and the banner invites the user in", async () => {
      await expect(window.locator(SEL.firstRun.agentSetupBanner)).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(window.locator(SEL.firstRun.agentSetupDialog)).not.toBeVisible();
    });

    await test.step("the banner CTA opens the wizard and Not now closes it", async () => {
      await window.locator(SEL.firstRun.agentSetupBannerCta).click();
      await expect(window.locator(SEL.firstRun.agentSetupDialog)).toBeVisible({
        timeout: T_MEDIUM,
      });

      await window.getByTestId("agent-setup-exit").click();
      await expect(window.locator(SEL.firstRun.agentSetupDialog)).not.toBeVisible({
        timeout: T_SETTLE,
      });
      await expect(window.locator(SEL.firstRun.agentSetupBanner)).toHaveCount(0, {
        timeout: T_SHORT,
      });
      await expect(setUpAgentsLink(window)).toBeVisible({ timeout: T_SHORT });
      await verifySettingsAccessible(window);

      // The dismissal is written over IPC after the banner hides; don't let the
      // quit below race it.
      await expect
        .poll(
          () =>
            window.evaluate(async () => {
              const state = await globalThis.window.electron.onboarding.get();
              return state.setupBannerDismissed === true;
            }),
          { timeout: T_MEDIUM, intervals: [100, 250, 500] }
        )
        .toBe(true);
    });

    await test.step("turn Performance Mode on", async () => {
      const toggle = await openPanelGridSettings(window);
      await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });
      await window.keyboard.press("Escape");

      await expect
        .poll(
          () =>
            window.evaluate(async () => {
              const config = await globalThis.window.electron.terminalConfig.get();
              return config.performanceMode === true;
            }),
          { timeout: T_MEDIUM, intervals: [100, 250, 500] }
        )
        .toBe(true);
    });

    await quit();
  });

  test("session 2: the banner and wizard stay away, the setting persisted, and a project is onboarded", async () => {
    ctx = await launchApp({
      userDataDir,
      env: FIRST_RUN_ENV,
      waitForSelector: SEL.firstRun.welcomeTitle,
    });
    const { window } = ctx;

    await test.step("welcome screen hydrates as already answered", async () => {
      await expect(window.locator(SEL.firstRun.welcomeTitle)).toBeVisible({ timeout: T_MEDIUM });
      // The positive gate: this link renders only once onboarding state has
      // loaded with the banner dismissed, so the absences below are checked
      // against a hydrated screen rather than one still loading.
      await expect(setUpAgentsLink(window)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.locator(SEL.firstRun.agentSetupBanner)).toHaveCount(0);
      await expect(window.locator(SEL.firstRun.agentSetupDialog)).toHaveCount(0);
      await verifySettingsAccessible(window);
    });

    await test.step("Performance Mode is still on", async () => {
      const toggle = await openPanelGridSettings(window);
      await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: T_MEDIUM });
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_MEDIUM });
    });

    await test.step("onboard the fixture project", async () => {
      ctx!.window = await openAndOnboardProject(ctx!.app, window, fixtureDir, "Persistence Test");
      const trigger = ctx!.window.locator(SEL.toolbar.projectSwitcherTrigger);
      await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
      await expect(trigger).toContainText(PROJECT_NAME, { timeout: T_SHORT });
    });

    await quit();
  });

  test("session 3: the onboarded project is restored", async () => {
    ctx = await launchApp({ userDataDir, env: FIRST_RUN_ENV });
    const { window } = ctx;

    const trigger = window.locator(SEL.toolbar.projectSwitcherTrigger);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await expect(trigger).toContainText(PROJECT_NAME, { timeout: T_MEDIUM });
  });
});
