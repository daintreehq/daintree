import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;

test.describe.serial("Core: Terminal Recipes", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test.describe.serial("Recipe Editor", () => {
    test.beforeAll(async () => {
      const fixtureDir = createFixtureRepo({ name: "terminal-recipes" });
      await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Recipes Test");
      await ctx.window.waitForTimeout(T_SETTLE);
    });

    async function openRecipesTab() {
      const { window } = ctx;
      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      const palette = window.locator(SEL.projectSwitcher.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      const settingsBtn = palette.locator(SEL.projectSwitcher.projectSettings);
      await expect(settingsBtn).toBeVisible({ timeout: T_SHORT });
      await settingsBtn.click();

      await expect(window.locator(SEL.projectSettings.heading)).toBeVisible({
        timeout: T_MEDIUM,
      });
      await window.locator(SEL.projectSettings.recipesTab).click();
    }

    async function closeProjectSettings() {
      const { window } = ctx;
      await window.locator(SEL.projectSettings.closeButton).click();
      await expect(window.locator(SEL.projectSettings.heading)).not.toBeVisible({
        timeout: T_SHORT,
      });
    }

    function getRecipeEditor(title: "Create Recipe" | "Edit Recipe" = "Create Recipe") {
      return ctx.window.getByRole("dialog").filter({ hasText: title });
    }

    test("recipe editor opens with name input and one terminal slot", async () => {
      const { window } = ctx;
      await openRecipesTab();

      await window.locator(SEL.projectSettings.addRecipeButton).click();

      const editor = getRecipeEditor();
      await expect(editor).toBeVisible({ timeout: T_MEDIUM });
      await expect(editor.locator(SEL.recipeEditor.nameInput)).toBeVisible({ timeout: T_SHORT });
      await expect(editor.locator(SEL.recipeEditor.terminalType(0))).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(editor.locator(SEL.recipeEditor.terminalCommand(0))).toBeVisible({
        timeout: T_SHORT,
      });

      // Cancel on clean form (no confirm needed)
      await editor.locator(SEL.recipeEditor.cancelButton).click();
      await expect(editor).not.toBeVisible({ timeout: T_SHORT });

      await closeProjectSettings();
    });

    test("fill and save a recipe", async () => {
      const { window } = ctx;
      await openRecipesTab();

      await window.locator(SEL.projectSettings.addRecipeButton).click();

      const editor = getRecipeEditor();
      await expect(editor).toBeVisible({ timeout: T_MEDIUM });

      await editor.locator(SEL.recipeEditor.nameInput).fill("E2E Test Recipe");
      await editor.locator(SEL.recipeEditor.terminalCommand(0)).fill("echo hello");

      // Add a second terminal
      await editor.locator(SEL.recipeEditor.addTerminalButton).click();
      await expect(editor.locator(SEL.recipeEditor.terminalType(1))).toBeVisible({
        timeout: T_SHORT,
      });
      await editor.locator(SEL.recipeEditor.terminalTitle(1)).fill("Second Terminal");

      // Save
      await editor.locator(SEL.recipeEditor.createButton).click();
      await expect(editor).not.toBeVisible({ timeout: T_MEDIUM });

      // Verify recipe appears in the list
      await expect(window.locator(SEL.projectSettings.heading)).toBeVisible({ timeout: T_SHORT });
      await expect(window.getByText("E2E Test Recipe").first()).toBeVisible({ timeout: T_MEDIUM });

      await closeProjectSettings();
    });

    test("edit reopens with saved values and cancel confirms unsaved changes", async () => {
      const { window } = ctx;
      await openRecipesTab();

      // Click edit on the saved recipe (button is opacity-0 until hover)
      await window
        .locator(SEL.projectSettings.editRecipeButton("E2E Test Recipe"))
        .click({ force: true });

      const editor = getRecipeEditor("Edit Recipe");
      await expect(editor).toBeVisible({ timeout: T_MEDIUM });

      // Verify saved values loaded
      await expect(editor.locator(SEL.recipeEditor.nameInput)).toHaveValue("E2E Test Recipe", {
        timeout: T_SHORT,
      });
      await expect(editor.locator(SEL.recipeEditor.terminalCommand(0))).toHaveValue("echo hello", {
        timeout: T_SHORT,
      });
      await expect(editor.locator(SEL.recipeEditor.terminalTitle(1))).toHaveValue(
        "Second Terminal",
        { timeout: T_SHORT }
      );

      // Make a change to trigger dirty state
      await editor.locator(SEL.recipeEditor.nameInput).fill("Modified Recipe");

      // Cancel but dismiss the confirm (stay in editor)
      window.once("dialog", (dialog) => dialog.dismiss());
      await editor.locator(SEL.recipeEditor.cancelButton).click();
      await expect(editor).toBeVisible({ timeout: T_SHORT });

      // Cancel again and accept the confirm (close editor without saving)
      window.once("dialog", (dialog) => dialog.accept());
      await editor.locator(SEL.recipeEditor.cancelButton).click();
      await expect(editor).not.toBeVisible({ timeout: T_SHORT });

      // Reopen and verify original name was preserved (cancel did not save)
      await window
        .locator(SEL.projectSettings.editRecipeButton("E2E Test Recipe"))
        .click({ force: true });
      const editorAgain = getRecipeEditor("Edit Recipe");
      await expect(editorAgain).toBeVisible({ timeout: T_MEDIUM });
      await expect(editorAgain.locator(SEL.recipeEditor.nameInput)).toHaveValue("E2E Test Recipe", {
        timeout: T_SHORT,
      });

      // Close without changes
      await editorAgain.locator(SEL.recipeEditor.cancelButton).click();
      await expect(editorAgain).not.toBeVisible({ timeout: T_SHORT });

      await closeProjectSettings();
    });

    test("edit and save updates the recipe", async () => {
      const { window } = ctx;
      await openRecipesTab();

      await window
        .locator(SEL.projectSettings.editRecipeButton("E2E Test Recipe"))
        .click({ force: true });

      const editor = getRecipeEditor("Edit Recipe");
      await expect(editor).toBeVisible({ timeout: T_MEDIUM });

      // Update the recipe name
      await editor.locator(SEL.recipeEditor.nameInput).fill("E2E Updated Recipe");
      await editor.locator(SEL.recipeEditor.updateButton).click();
      await expect(editor).not.toBeVisible({ timeout: T_MEDIUM });

      // Verify updated name appears in the list and old name is gone
      await expect(window.getByText("E2E Updated Recipe")).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.getByText("E2E Test Recipe")).not.toBeVisible({ timeout: T_SHORT });

      // Reopen to verify the update persisted
      await window
        .locator(SEL.projectSettings.editRecipeButton("E2E Updated Recipe"))
        .click({ force: true });
      const editorAgain = getRecipeEditor("Edit Recipe");
      await expect(editorAgain.locator(SEL.recipeEditor.nameInput)).toHaveValue(
        "E2E Updated Recipe",
        { timeout: T_SHORT }
      );
      await editorAgain.locator(SEL.recipeEditor.cancelButton).click();
      await expect(editorAgain).not.toBeVisible({ timeout: T_SHORT });

      await closeProjectSettings();
    });

    test("empty name shows validation error", async () => {
      const { window } = ctx;
      await openRecipesTab();

      await window.locator(SEL.projectSettings.addRecipeButton).click();

      const editor = getRecipeEditor();
      await expect(editor).toBeVisible({ timeout: T_MEDIUM });

      // Leave name empty and try to save
      await editor.locator(SEL.recipeEditor.createButton).click();

      // Validation error should appear and editor should stay open
      await expect(editor.getByText("Recipe name is required")).toBeVisible({ timeout: T_SHORT });
      await expect(editor).toBeVisible();

      // Cancel (no dirty state since only validation was triggered)
      await editor.locator(SEL.recipeEditor.cancelButton).click();
      await expect(editor).not.toBeVisible({ timeout: T_SHORT });

      await closeProjectSettings();
    });
  });
});
