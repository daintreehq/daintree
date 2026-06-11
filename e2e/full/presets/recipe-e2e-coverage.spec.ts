import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, createFixtureRepoWithRecipes } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";

// E2E coverage for recipe and onboarding surfaces that lacked specs (#9597):
// the stale-write conflict dialog, RecipeManager clipboard export/import,
// Team-scope + shadowing rows, the GettingStartedChecklist, RecipeRunner
// suggestion pills, recipe terminal-type marshaling, and the variable preview.
// The recipe-editor CRUD basics live in core-terminal-recipes.spec.ts and are
// intentionally not duplicated here.

async function openRecipeManager(window: Page): Promise<Locator> {
  await dismissBlockingPalette(window).catch(() => undefined);
  await window.evaluate(() =>
    window.dispatchEvent(new CustomEvent("daintree:open-recipe-manager"))
  );
  const dialog = window.locator(SEL.recipeManager.dialog);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
  return dialog;
}

async function closeAppDialog(window: Page): Promise<void> {
  // Escape closes the topmost AppDialog; assert the portal fully detaches so a
  // lingering FocusScope can't swallow keys in the next serial test (#6289).
  await window.keyboard.press("Escape");
  await expect(window.locator('[role="dialog"]')).toHaveCount(0, { timeout: T_MEDIUM });
}

function getRecipeEditor(window: Page, title: "Create Recipe" | "Edit Recipe" = "Create Recipe") {
  return window.getByRole("dialog").filter({ hasText: title });
}

// Opens the project-settings Recipes tab and closes it. This is the canonical
// trigger for recipeStore.loadRecipes(currentProject.id) (RecipesTab mount):
// it sets the recipe store's currentProjectId and loads global/in-repo/project
// recipes from disk. E2E project hydration does not auto-run loadRecipes, so
// in-repo recipes and the RecipeRunner's currentProjectId gate need this first.
async function loadRecipesViaSettings(window: Page): Promise<void> {
  await dismissBlockingPalette(window).catch(() => undefined);
  await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
  const palette = window.locator(SEL.projectSwitcher.palette);
  await expect(palette).toBeVisible({ timeout: T_MEDIUM });
  await palette.locator(SEL.projectSwitcher.projectSettings).click();
  await expect(window.locator(SEL.projectSettings.heading)).toBeVisible({ timeout: T_MEDIUM });
  await window.locator(SEL.projectSettings.recipesTab).click();
  await window.waitForTimeout(T_SETTLE);
  await window.locator(SEL.projectSettings.closeButton).click();
  await expect(window.locator(SEL.projectSettings.heading)).not.toBeVisible({ timeout: T_SHORT });
}

// Creates a project recipe through the RecipeManager → editor flow. The manager
// closes itself when the editor opens (handleRecipeManagerCreate), so callers
// reopen it afterward if they need the resulting row.
async function createProjectRecipe(window: Page, name: string): Promise<void> {
  const manager = await openRecipeManager(window);
  await manager.locator(SEL.recipeManager.newProjectRecipeButton).first().click({ force: true });

  const editor = getRecipeEditor(window);
  await expect(editor).toBeVisible({ timeout: T_MEDIUM });
  await editor.locator(SEL.recipeEditor.nameInput).fill(name);
  await editor.locator(SEL.recipeEditor.terminalCommand(0)).fill("echo hi");
  await editor.locator(SEL.recipeEditor.createButton).click();
  await expect(editor).not.toBeVisible({ timeout: T_MEDIUM });
}

test.describe.serial("Recipe & onboarding coverage (#9597)", () => {
  // ---------------------------------------------------------------------------
  // Surfaces that share one app + one plain project: conflict dialog, clipboard
  // export/import, terminal-type marshaling, variable preview.
  // ---------------------------------------------------------------------------
  test.describe.serial("Recipe dialogs", () => {
    let ctx: AppContext;
    let cleanup: (() => void) | undefined;

    test.beforeAll(async () => {
      ctx = await launchApp();
      const { dir, cleanup: c } = createFixtureRepo({ name: "recipe-dialogs" });
      cleanup = c;
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Recipe Dialogs");
      await ctx.window.waitForTimeout(T_SETTLE);
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      cleanup?.();
    });

    test("conflict dialog resolves via reload from disk", async () => {
      const { window } = ctx;
      await window.evaluate(() =>
        window.__DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__?.("Conflicting Recipe")
      );

      const dialog = window.locator(SEL.recipeConflict.dialog);
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await expect(dialog).toContainText("Conflicting Recipe");
      await expect(window.locator(SEL.recipeConflict.overwriteButton)).toBeVisible({
        timeout: T_SHORT,
      });

      await window.locator(SEL.recipeConflict.reloadButton).click();
      await expect(dialog).toHaveCount(0, { timeout: T_MEDIUM });
    });

    test("conflict dialog resolves via overwrite", async () => {
      const { window } = ctx;
      await window.evaluate(() =>
        window.__DAINTREE_E2E_TRIGGER_RECIPE_CONFLICT__?.("Conflicting Recipe")
      );

      const dialog = window.locator(SEL.recipeConflict.dialog);
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

      await window.locator(SEL.recipeConflict.overwriteButton).click();
      await expect(dialog).toHaveCount(0, { timeout: T_MEDIUM });
    });

    test("export copies recipe JSON to the clipboard", async () => {
      const { app, window } = ctx;
      await createProjectRecipe(window, "Export Me");

      const manager = await openRecipeManager(window);
      await app.evaluate(({ clipboard }) => clipboard.writeText(""));

      const exportBtn = manager.locator(SEL.recipeManager.exportButton("Export Me"));
      await exportBtn.click({ force: true });

      // UI feedback flips only when the clipboard write resolves, so its
      // appearance confirms the copy succeeded before we read it back.
      await expect(manager.locator(SEL.recipeManager.exportedButton("Export Me"))).toBeVisible({
        timeout: T_MEDIUM,
      });

      const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText());
      const parsed = JSON.parse(clipboardText) as { name?: string };
      expect(parsed.name).toBe("Export Me");

      await closeAppDialog(window);
    });

    test("import from clipboard adds a recipe to the manager", async () => {
      const { window } = ctx;
      const manager = await openRecipeManager(window);

      await manager.locator(SEL.recipeManager.importButton).first().click({ force: true });
      const importDialog = window.locator(SEL.recipeManager.importDialog);
      await expect(importDialog).toBeVisible({ timeout: T_MEDIUM });

      const payload = JSON.stringify({
        name: "Imported Recipe",
        terminals: [{ type: "terminal", title: "", command: "echo imported", env: {} }],
      });
      await importDialog.locator(SEL.recipeManager.importTextarea).fill(payload);
      await importDialog.locator(SEL.recipeManager.importConfirmButton).click();
      await expect(importDialog).not.toBeVisible({ timeout: T_MEDIUM });

      // A project-scoped import persists to the repo (scope: "inrepo"), so the
      // imported recipe shows up in the manager once the store settles.
      await expect(manager.getByText("Imported Recipe", { exact: true })).toBeVisible({
        timeout: T_LONG,
      });

      await closeAppDialog(window);
    });

    test("terminal-type field round-trips through create and reopen", async () => {
      const { window } = ctx;

      // Create a recipe with an agent terminal type.
      const manager = await openRecipeManager(window);
      await manager
        .locator(SEL.recipeManager.newProjectRecipeButton)
        .first()
        .click({ force: true });

      const editor = getRecipeEditor(window);
      await expect(editor).toBeVisible({ timeout: T_MEDIUM });
      await editor.locator(SEL.recipeEditor.nameInput).fill("Typed Recipe");
      await editor.locator(SEL.recipeEditor.terminalType(0)).selectOption("claude");

      // Switching to an agent type reveals the agent-only initial-prompt field —
      // proof the type value drives the conditional terminal marshaling.
      await expect(editor.locator("#terminal-initial-prompt-0")).toBeVisible({ timeout: T_SHORT });

      await editor.locator(SEL.recipeEditor.createButton).click();
      await expect(editor).not.toBeVisible({ timeout: T_MEDIUM });

      // Reopen the recipe and confirm the agent type persisted across the round-trip.
      const reopenManager = await openRecipeManager(window);
      await reopenManager.getByLabel("Edit recipe Typed Recipe").click({ force: true });
      const reopened = getRecipeEditor(window, "Edit Recipe");
      await expect(reopened).toBeVisible({ timeout: T_MEDIUM });
      await expect(reopened.locator(SEL.recipeEditor.terminalType(0))).toHaveValue("claude", {
        timeout: T_SHORT,
      });

      await reopened.locator(SEL.recipeEditor.cancelButton).click();
      await expect(reopened).not.toBeVisible({ timeout: T_SHORT });
      await expect(window.locator('[role="dialog"]')).toHaveCount(0, { timeout: T_MEDIUM });
    });

    test("variable preview renders unresolved tokens for an agent prompt", async () => {
      const { window } = ctx;
      const manager = await openRecipeManager(window);
      await manager
        .locator(SEL.recipeManager.newProjectRecipeButton)
        .first()
        .click({ force: true });

      const editor = getRecipeEditor(window);
      await expect(editor).toBeVisible({ timeout: T_MEDIUM });
      await editor.locator(SEL.recipeEditor.nameInput).fill("Variable Preview Recipe");
      await editor.locator(SEL.recipeEditor.terminalType(0)).selectOption("claude");

      const promptField = editor.locator("#terminal-initial-prompt-0");
      await expect(promptField).toBeVisible({ timeout: T_SHORT });
      await promptField.fill("Work on {{branch_name}} now");

      // No worktree context in the create flow → tokens stay highlighted and the
      // preview tells the user they resolve at run time.
      await expect(editor.getByText("Resolved prompt")).toBeVisible({ timeout: T_SHORT });
      await expect(editor.getByText("Resolving at run time")).toBeVisible({ timeout: T_SHORT });
      await expect(editor.locator(".bg-category-amber-subtle").first()).toBeVisible({
        timeout: T_SHORT,
      });

      // Cancel without saving (dirty → discard-changes confirm dialog).
      await editor.locator(SEL.recipeEditor.cancelButton).click();
      const discardDialog = window.getByRole("alertdialog").filter({ hasText: "Discard changes" });
      await expect(discardDialog).toBeVisible({ timeout: T_SHORT });
      await discardDialog.locator(SEL.confirmDialog.confirm).click();
      await expect(editor).not.toBeVisible({ timeout: T_MEDIUM });
      await expect(window.locator('[role="dialog"]')).toHaveCount(0, { timeout: T_MEDIUM });
    });
  });

  // ---------------------------------------------------------------------------
  // Team scope + shadowing: seed an in-repo recipe, then shadow it with a
  // same-named project recipe.
  // ---------------------------------------------------------------------------
  test.describe.serial("Recipe scopes and shadowing", () => {
    let ctx: AppContext;
    let cleanup: (() => void) | undefined;

    test.beforeAll(async () => {
      ctx = await launchApp();
      const { dir, cleanup: c } = createFixtureRepoWithRecipes({
        name: "recipe-scopes",
        inRepoRecipes: [
          {
            name: "Shared Dev",
            terminals: [{ type: "terminal", command: "npm run dev", env: {} }],
          },
        ],
      });
      cleanup = c;
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Recipe Scopes");
      await ctx.window.waitForTimeout(T_SETTLE);
      // Load the seeded in-repo recipe from disk into the store.
      await loadRecipesViaSettings(ctx.window);
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      cleanup?.();
    });

    test("team section lists the in-repo recipe", async () => {
      const { window } = ctx;
      const manager = await openRecipeManager(window);
      await expect(manager.locator(SEL.recipeManager.teamSection)).toBeVisible({ timeout: T_LONG });
      // The in-repo recipe also has a reconciled project-mirror row, so the name
      // can appear more than once — assert it's present rather than unique.
      await expect(manager.getByText("Shared Dev", { exact: true }).first()).toBeVisible({
        timeout: T_SHORT,
      });
      await closeAppDialog(window);
    });

    test("a same-named machine-local project recipe is marked as overridden", async () => {
      const { window } = ctx;
      // The shadow badge only renders for a machine-local project recipe whose
      // name collides with an in-repo recipe. The editor create flow writes
      // in-repo recipes, so seed the machine-local one through the project IPC.
      await window.evaluate(async () => {
        const project = await window.electron.project.getCurrent();
        if (!project?.id) throw new Error("No active project");
        await window.electron.project.addRecipe(project.id, {
          id: "recipe-local-shadow",
          name: "Shared Dev",
          projectId: project.id,
          terminals: [{ type: "terminal" as const, title: "", command: "echo local", env: {} }],
          createdAt: 1_700_000_000_000,
        });
      });
      // Reload so the store picks up the newly-seeded machine-local recipe
      // alongside the in-repo one.
      await loadRecipesViaSettings(window);

      const manager = await openRecipeManager(window);
      await expect(manager.locator(SEL.recipeManager.overriddenBadge).first()).toBeVisible({
        timeout: T_LONG,
      });
      await closeAppDialog(window);
    });
  });

  // ---------------------------------------------------------------------------
  // RecipeRunner empty state: a project with package.json scripts and no recipes
  // surfaces suggestion pills in the content-grid empty state.
  // ---------------------------------------------------------------------------
  test.describe.serial("Recipe runner empty state", () => {
    let ctx: AppContext;
    let cleanup: (() => void) | undefined;

    test.beforeAll(async () => {
      ctx = await launchApp();
      const { dir, cleanup: c } = createFixtureRepoWithRecipes({
        name: "recipe-runner",
        packageScripts: { dev: "vite", test: "vitest" },
      });
      cleanup = c;
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Recipe Runner");
      await ctx.window.waitForTimeout(T_SETTLE);
      // Sets the recipe store's currentProjectId so the RecipeRunner (gated on
      // recipesProjectId !== null) renders in the content-grid empty state.
      await loadRecipesViaSettings(ctx.window);
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      cleanup?.();
    });

    test("empty state surfaces package.json suggestion pills", async () => {
      const { window } = ctx;
      await dismissBlockingPalette(window).catch(() => undefined);

      const empty = window.locator(SEL.recipeRunner.emptyState);
      await expect(empty).toBeVisible({ timeout: T_LONG });

      const pills = empty.locator(SEL.recipeRunner.suggestionPill);
      await expect(pills).toHaveCount(2, { timeout: T_MEDIUM });
      // Detection order isn't guaranteed; assert the "dev" script surfaced on
      // one of the pills rather than pinning it to a position.
      await expect(empty.getByText("dev", { exact: false }).first()).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(empty.getByRole("button", { name: /Create your first recipe/ })).toBeVisible({
        timeout: T_SHORT,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GettingStartedChecklist: force it visible (forceShow path), then mark /
  // collapse / dismiss with persistence checks. Launched with the first-run
  // skip disabled so the checklist starts fresh instead of pre-dismissed.
  // ---------------------------------------------------------------------------
  test.describe.serial("Getting started checklist", () => {
    let ctx: AppContext;
    let cleanup: (() => void) | undefined;

    test.beforeAll(async () => {
      ctx = await launchApp({ env: { DAINTREE_E2E_SKIP_FIRST_RUN_DIALOGS: "0" } });
      const { dir, cleanup: c } = createFixtureRepo({ name: "checklist" });
      cleanup = c;
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Checklist");
      await ctx.window.waitForTimeout(T_SETTLE);
    });

    test.afterAll(async () => {
      if (ctx?.app) await closeApp(ctx.app);
      cleanup?.();
    });

    async function showChecklist(window: Page): Promise<Locator> {
      await window.evaluate(() => window.dispatchEvent(new Event("daintree:show-getting-started")));
      const panel = window.locator(SEL.checklist.panel);
      await expect(panel).toBeVisible({ timeout: T_MEDIUM });
      return panel;
    }

    test("marking an item via IPC persists and reflects on re-show", async () => {
      const { window } = ctx;
      const panel = await showChecklist(window);
      await expect(panel.getByText("Getting started")).toBeVisible({ timeout: T_SHORT });

      // createdWorktree won't auto-complete in a single-worktree project.
      const item = panel.locator(SEL.checklist.item("createdWorktree"));
      await expect(item).toBeVisible({ timeout: T_SHORT });

      await window.evaluate(() => window.electron.onboarding.markChecklistItem("createdWorktree"));

      const persisted = await window.evaluate(() => window.electron.onboarding.getChecklist());
      expect(persisted.items.createdWorktree).toBe(true);

      // Re-show re-hydrates from disk, so the row now renders as done (rendered
      // as a <div>, not the actionable <button>).
      const repanel = await showChecklist(window);
      await expect(repanel.locator(`div${SEL.checklist.item("createdWorktree")}`)).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("collapse toggles the body and dismiss persists", async () => {
      const { window } = ctx;
      const panel = await showChecklist(window);

      const toggle = window.locator(SEL.checklist.toggleButton);
      await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: T_SHORT });
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "false", { timeout: T_SHORT });

      await window.locator(SEL.checklist.dismissButton).click();
      await expect(panel).toHaveCount(0, { timeout: T_MEDIUM });

      const persisted = await window.evaluate(() => window.electron.onboarding.getChecklist());
      expect(persisted.dismissed).toBe(true);
    });
  });
});
