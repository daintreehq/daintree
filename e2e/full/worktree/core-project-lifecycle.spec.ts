import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  addAndSwitchToProject,
  selectExistingProjectAndRefresh,
  spawnTerminalAndVerify,
} from "../../helpers/workflows";
import { getGridPanelCount } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

const PROJECT_A = "lifecycle-a";
const PROJECT_B = "lifecycle-b";
const RECIPE_NAME = "Lifecycle Recipe";

let ctx: AppContext;
let repoBPath: string;
let cleanupA: (() => void) | undefined;
let cleanupB: (() => void) | undefined;

test.describe.serial("Core: Project Lifecycle", () => {
  test.beforeAll(async () => {
    const repoA = createFixtureRepo({ name: "lifecycle-a" });
    const repoB = createFixtureRepo({ name: "lifecycle-b" });
    cleanupA = repoA.cleanup;
    cleanupB = repoB.cleanup;
    repoBPath = repoB.dir;

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repoA.dir, PROJECT_A);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    cleanupA?.();
    cleanupB?.();
  });

  test("add second project via project switcher", async () => {
    ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, repoBPath, PROJECT_B);
    const { window } = ctx;

    // Verify both projects are listed in the switcher
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    await expect(palette.getByText(PROJECT_A, { exact: false })).toBeVisible({ timeout: T_SHORT });
    await expect(palette.getByText(PROJECT_B, { exact: false })).toBeVisible({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });
  });

  test("every part of the pill opens the switcher; identity editing lives on right-click", async () => {
    const { window } = ctx;
    const pill = window.locator(SEL.toolbar.projectSwitcherTrigger);
    const palette = window.locator(SEL.projectSwitcher.palette);
    const identityEditor = window.getByLabel("Edit project identity");

    // The emoji used to carry an invisible 28px target of its own, so a click
    // meant for the switcher opened the rename popover instead — and both open
    // with a text field focused, so the switcher's click-type-Enter habit
    // renamed the project. Asserted by POSITION because the regression is in
    // the hit map, not in any handler a unit test can see.
    const box = await pill.boundingBox();
    expect(box).not.toBeNull();
    await pill.click({ position: { x: 14, y: box!.height / 2 } });

    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await expect(identityEditor).not.toBeVisible();

    await window.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });

    // Right-click anywhere on the pill is the way in now.
    await pill.click({ button: "right" });
    const editItem = window.getByRole("menuitem", { name: /Edit name and icon/ });
    await expect(editItem).toBeVisible({ timeout: T_SHORT });
    await editItem.click();

    await expect(identityEditor).toBeVisible({ timeout: T_MEDIUM });
    // Escape cancels the edit rather than committing it, so the suite's later
    // project-name assertions still hold.
    await window.keyboard.press("Escape");
    await expect(identityEditor).not.toBeVisible({ timeout: T_SHORT });
  });

  test("switch between projects with panel isolation", async () => {
    // Switch to Project A and spawn a terminal
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    await spawnTerminalAndVerify(ctx.window);
    expect(await getGridPanelCount(ctx.window)).toBe(1);

    // Switch to Project B — should have 0 panels
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);
    await expect.poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG }).toBe(0);

    // Switch back to Project A — at least 1 panel should be restored
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    await expect
      .poll(() => getGridPanelCount(ctx.window), { timeout: T_LONG })
      .toBeGreaterThanOrEqual(1);
  });

  test("project settings shows correct project name", async () => {
    // Re-acquire the active window so we know which view is current after the
    // previous switch-isolation test left things on Project A.
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);

    // Open project settings for Project A (currently active)
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    let palette = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const settingsBtn = palette.locator(SEL.projectSwitcher.projectSettings);
    await expect(settingsBtn).toBeVisible({ timeout: T_SHORT });
    await settingsBtn.click();

    await expect(ctx.window.locator(SEL.projectSettings.heading)).toBeVisible({
      timeout: T_MEDIUM,
    });

    await expect(ctx.window.locator("#project-name-input")).toHaveValue(new RegExp(PROJECT_A), {
      timeout: T_SHORT,
    });

    // Close settings
    await ctx.window.locator(SEL.projectSettings.closeButton).click();
    await expect(ctx.window.locator(SEL.projectSettings.heading)).not.toBeVisible({
      timeout: T_SHORT,
    });

    // Switch to Project B and verify its name in settings
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_B);

    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    palette = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await palette.locator(SEL.projectSwitcher.projectSettings).click();

    await expect(ctx.window.locator(SEL.projectSettings.heading)).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(ctx.window.locator("#project-name-input")).toHaveValue(new RegExp(PROJECT_B), {
      timeout: T_SHORT,
    });

    await ctx.window.locator(SEL.projectSettings.closeButton).click();
    await expect(ctx.window.locator(SEL.projectSettings.heading)).not.toBeVisible({
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
    // Switch to Project A so Project B is inactive
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PROJECT_A);
    const { window } = ctx;

    // Open palette and remove Project B via context menu
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    const projectBOption = palette.getByRole("option", { name: new RegExp(PROJECT_B) });
    await expect(projectBOption).toBeVisible({ timeout: T_SHORT });
    // Right-click to open the context menu for this project row.
    await projectBOption.click({ button: "right" });
    const removeItem = window.getByRole("menuitem", { name: "Remove project" });
    await expect(removeItem).toBeVisible({ timeout: T_SHORT });
    await removeItem.click();

    // Confirm removal
    const dialog = window.getByRole("alertdialog", { name: "Remove project from list?" }).last();
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    await dialog.getByRole("button", { name: "Remove project" }).click();
    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // Verify Project B is gone from the palette
    await window.waitForTimeout(T_SETTLE);
    await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await expect(palette.getByText(PROJECT_B, { exact: false })).not.toBeVisible({
      timeout: T_SHORT,
    });

    // Project A should still be listed
    await expect(palette.getByText(PROJECT_A, { exact: false })).toBeVisible({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });
  });
});
