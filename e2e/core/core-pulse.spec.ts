import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

test.describe.serial("Core: Project Pulse", () => {
  let ctx: AppContext;

  test.beforeAll(async () => {
    ctx = await launchApp();
    const dir = createFixtureRepo({ name: "pulse-test", withSpreadCommits: true });
    await openAndOnboardProject(ctx.app, ctx.window, dir, "Pulse Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("pulse card is visible after onboarding", async () => {
    const { window } = ctx;
    await expect(window.locator(SEL.pulse.summary)).toBeVisible({ timeout: T_LONG });
  });

  test("card header shows project name and default range", async () => {
    const { window } = ctx;
    const title = window.getByText("Pulse Test Project Pulse");
    await expect(title).toBeVisible({ timeout: T_MEDIUM });
    const rangeTrigger = window.locator(SEL.pulse.rangeTrigger);
    await expect(rangeTrigger).toContainText("60 days", { timeout: T_SHORT });
  });

  test("range selector changes time range", async () => {
    const { window } = ctx;
    const trigger = window.locator(SEL.pulse.rangeTrigger);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await trigger.click();

    const menu = window.getByRole("menu");
    await expect(menu).toBeVisible({ timeout: T_SHORT });

    const item = window.getByRole("menuitem", { name: "120 days" });
    await item.click();

    await expect(trigger).toContainText("120 days", { timeout: T_MEDIUM });
    await expect(window.locator(SEL.pulse.summary)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("refresh button reloads data", async () => {
    const { window } = ctx;
    const refreshBtn = window.locator(SEL.pulse.refreshButton);
    await expect(refreshBtn).toBeEnabled({ timeout: T_SHORT });
    await refreshBtn.click();
    await expect(refreshBtn).toBeEnabled({ timeout: T_LONG });
    await expect(window.locator(SEL.pulse.summary)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("settings toggle hides pulse card", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.openSettings).click();
    const heading = window.locator(SEL.settings.heading);
    await expect(heading).toBeVisible({ timeout: T_MEDIUM });

    const generalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("General")`);
    await generalTab.click();

    const displaySubtab = window.locator(
      '#settings-panel-general button[role="tab"]:has-text("Display")'
    );
    await displaySubtab.click();

    const toggle = window.locator(SEL.settings.projectPulseToggle);
    await expect(toggle).toBeVisible({ timeout: T_MEDIUM });
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: T_SHORT });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(heading).not.toBeVisible({ timeout: T_SHORT });

    await expect(window.locator(SEL.pulse.summary)).not.toBeVisible({ timeout: T_MEDIUM });
  });
});

test.describe.serial("Core: Project Pulse — minimal repo", () => {
  let ctx: AppContext;

  test.beforeAll(async () => {
    ctx = await launchApp();
    const dir = createFixtureRepo({ name: "pulse-minimal" });
    await openAndOnboardProject(ctx.app, ctx.window, dir, "Pulse Minimal");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("card renders without error for a single-commit repo", async () => {
    const { window } = ctx;
    const summary = window.locator(SEL.pulse.summary);

    await expect(summary).toBeVisible({ timeout: T_LONG });
    // The pulse error state uses aria-label="Retry now" — ensure it's absent
    await expect(window.locator('[aria-label="Retry now"]')).not.toBeVisible({ timeout: T_SHORT });
  });
});
