import { test, expect } from "@playwright/test";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;
const PRIMARY_NAME = "Primary Advanced";
const SECONDARY_NAME = "Secondary Remove";

test.describe.serial("Core: Project Management Advanced", () => {
  test.beforeAll(async () => {
    const primaryRepo = createFixtureRepo({
      name: "primary-advanced",
      withFeatureBranch: true,
    });
    const secondaryRepo = createFixtureRepo({ name: "secondary-remove" });

    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, primaryRepo, PRIMARY_NAME);

    // Add secondary project
    await mockOpenDialog(ctx.app, secondaryRepo);
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    const palette = ctx.window.locator(SEL.projectSwitcher.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    await ctx.window.locator(SEL.projectSwitcher.addButton).click({ force: true });

    const heading = ctx.window.locator("h2", { hasText: "Set up your project" });
    await expect(heading).toBeVisible({ timeout: T_LONG });
    const nameInput = ctx.window.getByRole("textbox", { name: "Project Name" });
    await nameInput.fill(SECONDARY_NAME);
    await ctx.window.getByRole("button", { name: "Finish" }).click();
    await expect(heading).not.toBeVisible({ timeout: T_MEDIUM });

    // Switch back to primary project
    await ctx.window.locator(SEL.toolbar.projectSwitcherTrigger).click();
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });
    const primaryRow = palette.locator(`text="${PRIMARY_NAME}"`);
    await primaryRow.click();
    await expect(palette).not.toBeVisible({ timeout: T_MEDIUM });

    // Verify primary project is active by checking sidebar has worktree cards
    await expect(ctx.window.locator("[data-worktree-branch]").first()).toBeVisible({
      timeout: T_LONG,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Project Removal Confirmation (3 tests) ──────────────

  test.describe.serial("Project Removal Confirmation", () => {
    test("cancel leaves project intact", async () => {
      const { window } = ctx;

      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      const palette = window.locator(SEL.projectSwitcher.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      // Find the secondary project row and click its close/remove button
      const secondaryOption = palette.getByRole("option", { name: new RegExp(SECONDARY_NAME) });
      await expect(secondaryOption).toBeVisible({ timeout: T_SHORT });
      await secondaryOption.locator(SEL.projectSwitcher.closeButton).click({ force: true });

      // Confirm dialog appears with project name
      const dialog = window.getByRole("dialog", { name: "Remove Project from List?" }).last();
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await expect(dialog.locator(`text="${SECONDARY_NAME}"`)).toBeVisible();

      // Cancel — project should remain
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

      // Reopen palette and verify project is still listed
      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });
      await expect(palette.locator(`text="${SECONDARY_NAME}"`)).toBeVisible({ timeout: T_SHORT });

      // Close palette
      await window.keyboard.press("Escape");
      await expect(palette).not.toBeVisible({ timeout: T_SHORT });
    });

    test("confirm removes project from list", async () => {
      const { window } = ctx;

      // Open palette and trigger removal again
      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      const palette = window.locator(SEL.projectSwitcher.palette);
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });

      const secondaryOption = palette.getByRole("option", { name: new RegExp(SECONDARY_NAME) });
      await secondaryOption.locator(SEL.projectSwitcher.closeButton).click({ force: true });

      const dialog = window.getByRole("dialog", { name: "Remove Project from List?" }).last();
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

      // Confirm removal
      await dialog.getByRole("button", { name: "Remove Project" }).click();
      await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

      // Verify project is gone from the palette
      await window.waitForTimeout(T_SETTLE);
      await window.locator(SEL.toolbar.projectSwitcherTrigger).click();
      await expect(palette).toBeVisible({ timeout: T_MEDIUM });
      await expect(palette.locator(`text="${SECONDARY_NAME}"`)).not.toBeVisible({
        timeout: T_SHORT,
      });

      // Close palette
      await window.keyboard.press("Escape");
    });
  });

  // ── Worktree Overview Modal (4 tests) ───────────────────

  test.describe.serial("Worktree Overview Modal", () => {
    test("modal opens via keyboard shortcut and shows worktree cards", async () => {
      const { window } = ctx;

      await window.keyboard.press(`${mod}+Shift+O`);

      const modal = window.locator(SEL.worktree.overviewModal);
      await expect(modal).toBeVisible({ timeout: T_LONG });
      await expect(modal.locator("h2", { hasText: "Worktrees Overview" })).toBeVisible();

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

      // Open filter popover
      await modal.locator(SEL.worktree.filterButton).click();
      const popover = window.locator(SEL.worktree.filterPopover);
      await expect(popover).toBeVisible({ timeout: T_SHORT });

      const searchInput = popover.locator('[aria-label="Search worktrees"]');

      // Search for a non-existent branch — active worktree may still show due to alwaysShowActive
      await searchInput.fill("nonexistent-branch-xyz-999");
      await window.waitForTimeout(T_SETTLE);

      // Card count should decrease (active worktree may remain visible)
      await expect
        .poll(() => cards.count(), {
          timeout: T_MEDIUM,
          message: "Expected fewer worktree cards for non-matching search",
        })
        .toBeLessThan(initialCount);

      // Clear search
      await popover.locator('[aria-label="Clear search"]').click();
      await window.waitForTimeout(T_SETTLE);

      // All cards should reappear
      await expect
        .poll(() => cards.count(), { timeout: T_MEDIUM })
        .toBeGreaterThanOrEqual(initialCount);

      // Close popover by clicking the filter button again (toggle)
      await modal.locator(SEL.worktree.filterButton).click();
      await expect(popover).not.toBeVisible({ timeout: T_SHORT });
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
