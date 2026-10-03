import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Worktree Sidebar Search", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "sidebar-search", withFeatureBranch: true });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Sidebar Search");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("search filters worktree cards, shows the no-match state, and clears", async () => {
    const { window } = ctx;
    const sidebar = window.locator(SEL.sidebar.aside);
    const mainCard = sidebar.locator('[data-worktree-branch][data-worktree-is-main="true"]');
    const featureCard = sidebar.locator('[data-worktree-branch="feature/test-branch"]');
    const searchInput = sidebar.locator(SEL.worktree.searchInput);

    await expect(mainCard).toBeVisible({ timeout: T_LONG });
    await expect(featureCard).toBeVisible({ timeout: T_LONG });

    await searchInput.fill("test-branch");
    await expect(featureCard).toBeVisible({ timeout: T_MEDIUM });
    await expect(mainCard).toHaveCount(0, { timeout: T_MEDIUM });

    await sidebar.locator(SEL.worktree.searchClear).click();
    await expect(searchInput).toHaveValue("");
    await expect(mainCard).toBeVisible({ timeout: T_MEDIUM });
    await expect(featureCard).toBeVisible({ timeout: T_MEDIUM });

    const query = "nonexistent-branch-xyz";
    await searchInput.fill(query);
    await expect(sidebar.getByText(`No matches for "${query}"`, { exact: true })).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(sidebar.locator("[data-worktree-branch]")).toHaveCount(0);

    await sidebar.getByRole("button", { name: "Show all worktrees" }).click();
    await expect(searchInput).toHaveValue("");
    await expect(mainCard).toBeVisible({ timeout: T_MEDIUM });
    await expect(featureCard).toBeVisible({ timeout: T_MEDIUM });
  });
});
