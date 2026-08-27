import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../../helpers/workflows";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;
const PRIMARY_NAME = "primary-advanced";
const SECONDARY_NAME = "secondary-remove";
let cleanupPrimary: (() => void) | undefined;
let cleanupSecondary: (() => void) | undefined;

test.describe.serial("Core: Project Management Advanced", () => {
  test.beforeAll(async () => {
    const primaryRepo = createFixtureRepo({
      name: "primary-advanced",
      withFeatureBranch: true,
    });
    const secondaryRepo = createFixtureRepo({ name: "secondary-remove" });
    cleanupPrimary = primaryRepo.cleanup;
    cleanupSecondary = secondaryRepo.cleanup;

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, primaryRepo.dir, PRIMARY_NAME);

    // Add secondary project
    ctx.window = await addAndSwitchToProject(
      ctx.app,
      ctx.window,
      secondaryRepo.dir,
      SECONDARY_NAME
    );

    // Switch back to primary project
    ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PRIMARY_NAME);

    // Verify primary project is active by checking sidebar has worktree cards
    await expect(ctx.window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_LONG,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    cleanupPrimary?.();
    cleanupSecondary?.();
  });

  // ── Project Removal Confirmation (3 tests) ──────────────

  test.describe.serial("Project Removal Confirmation", () => {
    test("cancel leaves project intact", async () => {
      const { window } = ctx;

      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      const palette = window.locator(SEL.projectSwitcher.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      // Find the secondary project row and trigger removal via context menu
      const secondaryOption = palette.getByRole("option", { name: new RegExp(SECONDARY_NAME) });
      await expect(secondaryOption).toBeVisible({ timeout: T_SHORT });
      await secondaryOption.click({ button: "right" });
      const removeItem = window.getByRole("menuitem", { name: "Remove project" });
      await expect(removeItem).toBeVisible({ timeout: T_SHORT });
      await removeItem.click();

      // Confirm dialog appears with project name
      const dialog = window.getByRole("alertdialog", { name: "Remove project from list?" }).last();
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await expect(dialog.getByText(SECONDARY_NAME, { exact: false }).first()).toBeVisible();

      // Cancel — project should remain
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

      // The cancel flow returns to the underlying switcher when it remains open.
      // Only click the trigger if the dialog teardown closed the switcher too.
      if (!(await palette.isVisible().catch(() => false))) {
        await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      }
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });
      await expect(palette.getByText(SECONDARY_NAME, { exact: false })).toBeVisible({
        timeout: T_SHORT,
      });

      // Close palette
      await dismissBlockingPalette(window);
      await expect(palette).not.toBeVisible({ timeout: T_SHORT });
    });

    test("confirm removes project from list", async () => {
      const { window } = ctx;

      // Open palette and trigger removal again
      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      const palette = window.locator(SEL.projectSwitcher.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      const secondaryOption = palette.getByRole("option", { name: new RegExp(SECONDARY_NAME) });
      await secondaryOption.click({ button: "right" });
      const removeItem2 = window.getByRole("menuitem", { name: "Remove project" });
      await expect(removeItem2).toBeVisible({ timeout: T_SHORT });
      await removeItem2.click();

      const dialog = window.getByRole("alertdialog", { name: "Remove project from list?" }).last();
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

      // Confirm removal
      await dialog.getByRole("button", { name: "Remove project" }).click();
      await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

      // Verify project is gone from the palette
      await window.waitForTimeout(T_SETTLE);
      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });
      await expect(palette.getByText(SECONDARY_NAME, { exact: false })).not.toBeVisible({
        timeout: T_SHORT,
      });

      // Close palette
      await dismissBlockingPalette(window);
      await expect(palette).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Worktree Overview Modal (4 tests) ───────────────────

  test.describe.serial("Worktree Overview Modal", () => {
    test("modal opens via keyboard shortcut and shows worktree cards", async () => {
      // Re-acquire the active window — the preceding project-removal tests
      // may have switched the active WebContentsView. Explicitly re-select
      // the primary project to ensure we're on the right view.
      ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, PRIMARY_NAME);
      const { window } = ctx;

      await window.keyboard.press(`${mod}+Shift+O`);

      const modal = window.locator(SEL.worktree.overviewModal);
      await expect(modal).toBeVisible({ timeout: T_LONG });
      await expect(modal.locator("h2", { hasText: "Worktrees overview" })).toBeVisible();

      // At least one worktree card should be visible (main + feature branch = 2)
      const cards = modal.locator("[data-worktree-branch]");
      await expect(cards.first()).toBeVisible({ timeout: T_LONG });
      await expect.poll(() => cards.count(), { timeout: T_MEDIUM }).toBeGreaterThanOrEqual(2);
    });

    test("search filtering narrows displayed worktrees", async () => {
      const { window } = ctx;
      const modal = window.locator(SEL.worktree.overviewModal);
      const cards = modal.locator("[data-worktree-branch]");

      // Capture initial card count
      const initialCount = await cards.count();
      expect(initialCount).toBeGreaterThanOrEqual(2);

      const searchInput = modal.getByRole("textbox", { name: "Search worktrees" });
      await expect(searchInput).toBeVisible({ timeout: T_MEDIUM });

      // Search for a non-existent branch — active worktree may still show due to alwaysShowActive
      await searchInput.fill("nonexistent-branch-xyz-999");

      // Card count should decrease (active worktree may remain visible)
      await expect
        .poll(() => cards.count(), {
          timeout: T_MEDIUM,
          message: "Expected fewer worktree cards for non-matching search",
        })
        .toBeLessThan(initialCount);

      await searchInput.fill("");

      // All cards should reappear
      await expect
        .poll(() => cards.count(), { timeout: T_MEDIUM })
        .toBeGreaterThanOrEqual(initialCount);
    });

    test("sort options toggle correctly", async () => {
      const { window } = ctx;
      const modal = window.locator(SEL.worktree.overviewModal);

      // Open filter popover
      await modal.locator(SEL.worktree.filterButton).click();
      const popover = window.locator(SEL.worktree.filterPopover);
      await expect(popover).toBeVisible({ timeout: T_SHORT });

      // Switch to Alphabetical sort
      const alphaRadio = popover.locator('[role="radio"]', { hasText: "Alphabetical" });
      await alphaRadio.click();
      await expect(alphaRadio).toHaveAttribute("aria-checked", "true");

      // Switch to Recently updated
      const recentRadio = popover.locator('[role="radio"]', { hasText: "Recently updated" });
      await recentRadio.click();
      await expect(recentRadio).toHaveAttribute("aria-checked", "true");
      await expect(alphaRadio).toHaveAttribute("aria-checked", "false");

      // Restore to Date created
      const createdRadio = popover.locator('[role="radio"]', { hasText: "Date created" });
      await createdRadio.click();
      await expect(createdRadio).toHaveAttribute("aria-checked", "true");

      // Close popover by toggling filter button
      await modal.locator(SEL.worktree.filterButton).click();
      await expect(popover).not.toBeVisible({ timeout: T_SHORT });
    });

    test("modal closes via close button", async () => {
      const { window } = ctx;

      const modal = window.locator(SEL.worktree.overviewModal);
      await modal.locator(SEL.worktree.overviewClose).click();
      await expect(modal).not.toBeVisible({ timeout: T_MEDIUM });

      // Verify sidebar worktree card is still visible (main UI intact)
      const sidebarCards = window.locator("[data-worktree-branch]");
      await expect(sidebarCards.first()).toBeVisible({ timeout: T_MEDIUM });
    });
  });
});
