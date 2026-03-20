import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import {
  addAndSwitchToProject,
  selectExistingProject,
  spawnTerminalAndVerify,
} from "../helpers/workflows";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

const PROJECT_A = "Lifecycle Project A";
const PROJECT_B = "Lifecycle Project B";
const RECIPE_NAME = "Lifecycle Recipe";

let ctx: AppContext;

test.describe.serial("Core: Project Lifecycle", () => {
  test.beforeAll(async () => {
    const repoA = createFixtureRepo({ name: "lifecycle-a" });
    const repoB = createFixtureRepo({ name: "lifecycle-b" });

    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, repoA, PROJECT_A);

    // Store repoB path for adding later
    (ctx as AppContext & { repoB: string }).repoB = repoB;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("add second project via project switcher", async () => {
    const { app, window } = ctx;
    const repoB = (ctx as AppContext & { repoB: string }).repoB;

    await addAndSwitchToProject(app, window, repoB, PROJECT_B);

    // Verify both projects are listed in the switcher
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    await expect(palette.locator(`text="${PROJECT_A}"`)).toBeVisible({ timeout: T_SHORT });
    await expect(palette.locator(`text="${PROJECT_B}"`)).toBeVisible({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });
  });

  test("switch between projects with panel isolation", async () => {
    const { window } = ctx;

    // Switch to Project A and spawn a terminal
    await selectExistingProject(window, PROJECT_A);
    await spawnTerminalAndVerify(window);
    expect(await getGridPanelCount(window)).toBe(1);

    // Switch to Project B — should have 0 panels
    await selectExistingProject(window, PROJECT_B);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);

    // Switch back to Project A — terminal should be restored
    await selectExistingProject(window, PROJECT_A);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(1);
  });

  test("project settings shows correct project name", async () => {
    const { window } = ctx;

    // Open project settings for Project A (currently active)
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const settingsBtn = palette.locator(SEL.projectSwitcher.projectSettings);
    await expect(settingsBtn).toBeVisible({ timeout: T_SHORT });
    await settingsBtn.click();

    await expect(window.locator(SEL.projectSettings.heading)).toBeVisible({ timeout: T_MEDIUM });

    // Verify project name input has Project A's name
    await expect(window.locator("#project-name-input")).toHaveValue(PROJECT_A, {
      timeout: T_SHORT,
    });

    // Close settings
    await window.locator(SEL.projectSettings.closeButton).click();
    await expect(window.locator(SEL.projectSettings.heading)).not.toBeVisible({
      timeout: T_SHORT,
    });

    // Switch to Project B and verify its name in settings
    await selectExistingProject(window, PROJECT_B);

    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await palette.locator(SEL.projectSwitcher.projectSettings).click();

    await expect(window.locator(SEL.projectSettings.heading)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator("#project-name-input")).toHaveValue(PROJECT_B, {
      timeout: T_SHORT,
    });

    await window.locator(SEL.projectSettings.closeButton).click();
    await expect(window.locator(SEL.projectSettings.heading)).not.toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("create a recipe via project settings", async () => {
    const { window } = ctx;

    // Open project settings and navigate to Recipes tab
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await palette.locator(SEL.projectSwitcher.projectSettings).click();

    await expect(window.locator(SEL.projectSettings.heading)).toBeVisible({ timeout: T_MEDIUM });
    await window.locator(SEL.projectSettings.recipesTab).click();

    // Add a recipe
    await window.locator(SEL.projectSettings.addRecipeButton).click();

    const editor = window.getByRole("dialog").filter({ hasText: "Create Recipe" });
    await expect(editor).toBeVisible({ timeout: T_MEDIUM });

    await editor.locator(SEL.recipeEditor.nameInput).fill(RECIPE_NAME);
    await editor.locator(SEL.recipeEditor.terminalCommand(0)).fill("echo lifecycle");

    await editor.locator(SEL.recipeEditor.createButton).click();
    await expect(editor).not.toBeVisible({ timeout: T_MEDIUM });

    // Verify recipe appears in the list
    await window.locator(SEL.projectSettings.recipesTab).click();
    await window.waitForTimeout(T_SETTLE);
    await expect(window.locator(SEL.projectSettings.editRecipeButton(RECIPE_NAME))).toBeAttached({
      timeout: T_LONG,
    });

    // Close project settings
    await window.locator(SEL.projectSettings.closeButton).click();
    await expect(window.locator(SEL.projectSettings.heading)).not.toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("remove project from switcher", async () => {
    const { window } = ctx;

    // Switch to Project A so Project B is inactive
    await selectExistingProject(window, PROJECT_A);

    // Open palette and remove Project B
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const projectBOption = palette.getByRole("option", { name: new RegExp(PROJECT_B) });
    await expect(projectBOption).toBeVisible({ timeout: T_SHORT });
    await projectBOption.locator(SEL.projectSwitcher.closeButton).click({ force: true });

    // Confirm removal
    const dialog = window.getByRole("dialog", { name: "Remove Project from List?" }).last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await dialog.getByRole("button", { name: "Remove Project" }).click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // Verify Project B is gone from the palette
    await window.waitForTimeout(T_SETTLE);
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await expect(palette.locator(`text="${PROJECT_B}"`)).not.toBeVisible({
      timeout: T_SHORT,
    });

    // Project A should still be listed
    await expect(palette.locator(`text="${PROJECT_A}"`)).toBeVisible({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });
  });
});
