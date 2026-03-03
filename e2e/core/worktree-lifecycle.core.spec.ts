import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";

let ctx: AppContext;
let mainBranch: string;

test.describe.serial("Worktree Lifecycle", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({
      name: "worktree-test",
      withFeatureBranch: true,
      withMultipleFiles: true,
    });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Worktree Test");
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("main worktree card is visible and selected", async () => {
    const { window } = ctx;

    // Find any worktree card — there should be at least one
    const cards = window.locator("[data-worktree-branch]");
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });

    // Get the branch name of the first (main) card
    mainBranch = (await cards.first().getAttribute("data-worktree-branch")) ?? "";
    expect(mainBranch.length).toBeGreaterThan(0);

    // It should be marked as selected
    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect(mainCard).toHaveAttribute("aria-label", /selected/);
  });

  test("create new worktree via UI", async () => {
    const { window } = ctx;

    // Click "+ New" button in the worktree sidebar header
    const newBtn = window.locator('button[title="Create new worktree"]');
    await newBtn.click();

    // Fill in branch name in the New Worktree dialog
    const branchInput = window.locator(SEL.worktree.branchNameInput);
    await expect(branchInput).toBeVisible({ timeout: 5_000 });
    await branchInput.fill("e2e/test-worktree");

    // Wait for the worktree path to be auto-populated (300ms debounce + async IPC)
    const pathInput = window.locator('[data-testid="worktree-path-input"]');
    await expect
      .poll(
        async () => {
          const val = await pathInput.inputValue();
          return val.trim().length;
        },
        { timeout: 10_000, message: "Worktree path should auto-populate" }
      )
      .toBeGreaterThan(0);

    // Click Create
    const createBtn = window.locator(SEL.worktree.createButton);
    await createBtn.click();

    // Wait for the new worktree card to appear
    const newCard = window.locator(SEL.worktree.card("e2e/test-worktree"));
    await expect(newCard).toBeVisible({ timeout: 30_000 });
  });

  test("switch to new worktree by clicking its card", async () => {
    const { window } = ctx;

    const newCard = window.locator(SEL.worktree.card("e2e/test-worktree"));
    await newCard.click();

    // New card should be selected
    await expect(newCard).toHaveAttribute("aria-label", /selected/, { timeout: 5_000 });
  });

  test("delete worktree via dropdown menu", async () => {
    const { window } = ctx;

    const newCard = window.locator(SEL.worktree.card("e2e/test-worktree"));
    const actionsBtn = newCard.locator(SEL.worktree.actionsMenu);
    await actionsBtn.click();

    const deleteItem = window.getByRole("menuitem", { name: /delete/i });
    await expect(deleteItem).toBeVisible({ timeout: 3_000 });
    await deleteItem.click();

    // Confirm deletion
    const confirmBtn = window.locator(SEL.worktree.deleteConfirm);
    await expect(confirmBtn).toBeVisible({ timeout: 5_000 });
    await confirmBtn.click();

    // Wait for card to disappear
    await expect(newCard).not.toBeVisible({ timeout: 15_000 });
  });

  test("main worktree remains after deletion", async () => {
    const { window } = ctx;

    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect(mainCard).toBeVisible({ timeout: 5_000 });
  });
});
