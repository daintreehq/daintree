import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../helpers/timeouts";

let ctx: AppContext;

test.describe.serial("Project Settings", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({
      name: "proj-settings",
      withMultipleFiles: true,
    });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Project Settings Test");
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("open project settings via project switcher", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();

    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const settingsBtn = palette.locator("button", { hasText: /Project Settings/ });
    await expect(settingsBtn).toBeVisible({ timeout: T_SHORT });
    await settingsBtn.click();

    const heading = window.locator('h2:has-text("Project Settings")');
    await expect(heading).toBeVisible({ timeout: T_MEDIUM });
  });

  test("project name is displayed", async () => {
    const { window } = ctx;

    const nameInput = window.locator('input[aria-label="Project name"]');
    if (await nameInput.isVisible().catch(() => false)) {
      const value = await nameInput.inputValue();
      expect(value).toContain("Project Settings Test");
    } else {
      const nameText = window.locator('text="Project Settings Test"');
      await expect(nameText).toBeVisible({ timeout: T_SHORT });
    }
  });

  test("dev server command input is visible", async () => {
    const { window } = ctx;

    const devInput = window.locator('[aria-label="Dev server command"]');
    await expect(devInput).toBeVisible({ timeout: T_SHORT });
  });

  test("close project settings via close button", async () => {
    const { window } = ctx;

    const closeBtn = window.locator('[aria-label="Close settings"]');
    await closeBtn.click();

    const heading = window.locator('h2:has-text("Project Settings")');
    await expect(heading).not.toBeVisible({ timeout: T_SHORT });
  });
});
