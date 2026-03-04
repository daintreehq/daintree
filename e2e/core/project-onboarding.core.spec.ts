import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openProject, completeOnboarding } from "../helpers/project";
import { T_MEDIUM, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Project Onboarding", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "onboard-test", withMultipleFiles: true });
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("open folder via mocked dialog shows onboarding wizard", async () => {
    await openProject(ctx.app, ctx.window, fixtureDir);

    const heading = ctx.window.locator("h2", { hasText: "Set up your project" });
    await expect(heading).toBeVisible({ timeout: T_LONG });
  });

  test("fill project name and finish onboarding", async () => {
    const { window } = ctx;

    const nameInput = window.getByRole("textbox", { name: "Project Name" });
    await nameInput.fill("Test Project");

    await window.getByRole("button", { name: "Finish" }).click();

    const heading = window.locator("h2", { hasText: "Set up your project" });
    await expect(heading).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("worktree dashboard appears with at least one card", async () => {
    const { window } = ctx;

    const worktreeCards = window.locator("[data-worktree-branch]");
    await expect(worktreeCards.first()).toBeVisible({ timeout: T_LONG });

    const count = await worktreeCards.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});
