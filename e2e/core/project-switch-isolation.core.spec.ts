import { test, expect } from "@playwright/test";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { createFixtureRepos } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;
let repos: string[];

test.describe.serial("Project Switch Isolation", () => {
  test.beforeAll(async () => {
    repos = createFixtureRepos(2);
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("open and onboard Project A with terminal", async () => {
    const { app, window } = ctx;

    await openAndOnboardProject(app, window, repos[0], "Project A");

    // Open a terminal
    await window.locator(SEL.toolbar.openTerminal).click();
    const panel = window.locator(SEL.panel.gridPanel).first();
    await expect(panel).toBeVisible({ timeout: T_LONG });

    const count = await getGridPanelCount(window);
    expect(count).toBe(1);
  });

  test("switch to Project B via project switcher", async () => {
    const { app, window } = ctx;

    // Mock dialog BEFORE clicking Add — it triggers the file dialog directly
    await mockOpenDialog(app, repos[1]);

    // Open project switcher
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();

    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    // Click "Add Project..." — opens mocked dialog, then shows onboarding
    const addBtn = window.locator(SEL.projectSwitcher.addButton);
    await addBtn.click();

    // Complete onboarding for Project B
    const heading = window.locator("h2", { hasText: "Set up your project" });
    await expect(heading).toBeVisible({ timeout: T_LONG });
    const nameInput = window.getByRole("textbox", { name: "Project Name" });
    await nameInput.fill("Project B");
    await window.getByRole("button", { name: "Finish" }).click();
    await expect(heading).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("Project B has 0 panels (isolation verified)", async () => {
    const { window } = ctx;

    // Give UI time to settle
    await window.waitForTimeout(1_000);

    const count = await getGridPanelCount(window);
    expect(count).toBe(0);
  });

  test("switch back to Project A restores 1 panel", async () => {
    const { window } = ctx;

    // Open project switcher and select Project A
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();

    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    // Click Project A in the list
    const projectA = palette.locator('text="Project A"');
    await projectA.click();

    // Wait for panels to restore
    await window.waitForTimeout(2_000);

    const count = await getGridPanelCount(window);
    expect(count).toBe(1);
  });
});
