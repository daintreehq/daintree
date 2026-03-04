import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

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
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("main worktree card is visible and selected", async () => {
    const { window } = ctx;

    const cards = window.locator("[data-worktree-branch]");
    await expect(cards.first()).toBeVisible({ timeout: T_LONG });

    mainBranch = (await cards.first().getAttribute("data-worktree-branch")) ?? "";
    expect(mainBranch.length).toBeGreaterThan(0);

    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect(mainCard).toHaveAttribute("aria-label", /selected/);
  });

  test("create new worktree via UI", async () => {
    const { window } = ctx;

    const newBtn = window.locator('button[title="Create new worktree"]');
    await newBtn.click();

    const branchInput = window.locator(SEL.worktree.branchNameInput);
    await expect(branchInput).toBeVisible({ timeout: T_MEDIUM });
    await branchInput.fill("e2e/test-worktree");

    // Wait for the worktree path to be auto-populated (300ms debounce + async IPC)
    const pathInput = window.locator('[data-testid="worktree-path-input"]');
    await expect
      .poll(
        async () => {
          const val = await pathInput.inputValue();
          return val.trim().length;
        },
        { timeout: T_LONG, message: "Worktree path should auto-populate" }
      )
      .toBeGreaterThan(0);

    const createBtn = window.locator(SEL.worktree.createButton);
    await createBtn.click();

    const newCard = window.locator(SEL.worktree.card("e2e/test-worktree"));
    await expect(newCard).toBeVisible({ timeout: 30_000 });
  });

  test("switch to new worktree by clicking its card", async () => {
    const { window } = ctx;

    const newCard = window.locator(SEL.worktree.card("e2e/test-worktree"));
    await newCard.click();

    await expect(newCard).toHaveAttribute("aria-label", /selected/, { timeout: T_MEDIUM });
  });

  test("delete worktree via dropdown menu", async () => {
    const { window } = ctx;

    const newCard = window.locator(SEL.worktree.card("e2e/test-worktree"));
    const actionsBtn = newCard.locator(SEL.worktree.actionsMenu);
    await actionsBtn.click();

    const deleteItem = window.getByRole("menuitem", { name: /delete/i });
    await expect(deleteItem).toBeVisible({ timeout: T_SHORT });
    await deleteItem.click();

    const confirmBtn = window.locator(SEL.worktree.deleteConfirm);
    await expect(confirmBtn).toBeVisible({ timeout: T_MEDIUM });
    await confirmBtn.click();

    await expect(newCard).not.toBeVisible({ timeout: T_LONG });
  });

  test("main worktree remains after deletion", async () => {
    const { window } = ctx;

    const mainCard = window.locator(SEL.worktree.card(mainBranch));
    await expect(mainCard).toBeVisible({ timeout: T_MEDIUM });
  });
});
