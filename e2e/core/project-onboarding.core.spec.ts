import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openProject, completeOnboarding } from "../helpers/project";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Project Onboarding", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "onboard-test", withMultipleFiles: true });
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("open folder via mocked dialog shows onboarding wizard", async () => {
    await openProject(ctx.app, ctx.window, fixtureDir);

    const heading = ctx.window.locator("h2", { hasText: "Set up your project" });
    await expect(heading).toBeVisible({ timeout: 10_000 });
  });

  test("fill project name and finish onboarding", async () => {
    const { window } = ctx;

    const nameInput = window.getByRole("textbox", { name: "Project Name" });
    await nameInput.fill("Test Project");

    await window.getByRole("button", { name: "Finish" }).click();

    const heading = window.locator("h2", { hasText: "Set up your project" });
    await expect(heading).not.toBeVisible({ timeout: 5_000 });
  });

  test("worktree dashboard appears with at least one card", async () => {
    const { window } = ctx;

    const worktreeCards = window.locator("[data-worktree-branch]");
    await expect(worktreeCards.first()).toBeVisible({ timeout: 10_000 });

    const count = await worktreeCards.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
