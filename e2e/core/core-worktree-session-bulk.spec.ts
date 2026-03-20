import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount, getDockPanelCount } from "../helpers/panels";
import { spawnTerminalAndVerify } from "../helpers/workflows";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
const FEATURE = "feature/test-branch";

test.describe.serial("Core: Worktree Session Bulk", () => {
  test.beforeAll(async () => {
    const fixture = createFixtureRepo({
      name: "worktree-session-bulk",
      withFeatureBranch: true,
    });

    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixture, "Session Bulk");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  async function openSessionsSubmenu() {
    const { window } = ctx;
    const featureCard = window.locator(SEL.worktree.card(FEATURE));
    const actionsBtn = featureCard.locator(SEL.worktree.actionsMenu);
    await actionsBtn.click();

    const sessionsTrigger = window.getByRole("menuitem", { name: "Sessions" });
    await expect(sessionsTrigger).toBeVisible({ timeout: T_SHORT });
    await sessionsTrigger.hover();
  }

  async function clickSessionsItem(name: string | RegExp) {
    const { window } = ctx;
    const item = window.getByRole("menuitem", { name });
    await expect(item).toBeVisible({ timeout: T_SHORT });
    await item.click();
  }

  test("select feature worktree and spawn 3 terminals", async () => {
    const { window } = ctx;

    const featureCard = window.locator(SEL.worktree.card(FEATURE));
    await featureCard.click({ position: { x: 10, y: 10 } });
    await expect
      .poll(() => featureCard.getAttribute("aria-label"), { timeout: T_LONG })
      .toContain("selected");

    await spawnTerminalAndVerify(window);
    await spawnTerminalAndVerify(window);
    await spawnTerminalAndVerify(window);

    expect(await getGridPanelCount(window)).toBe(3);
    expect(await getDockPanelCount(window)).toBe(0);
  });

  test("dock all sessions", async () => {
    const { window } = ctx;

    await openSessionsSubmenu();
    await clickSessionsItem(/Dock All/);

    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);
    await expect.poll(() => getDockPanelCount(window), { timeout: T_LONG }).toBe(3);
  });

  test("maximize all sessions", async () => {
    const { window } = ctx;

    await window.waitForTimeout(T_SETTLE);

    await openSessionsSubmenu();
    await clickSessionsItem(/Maximize All/);

    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);
    await expect.poll(() => getDockPanelCount(window), { timeout: T_LONG }).toBe(0);
  });

  test("close completed is disabled with no completed sessions", async () => {
    const { window } = ctx;

    await window.waitForTimeout(T_SETTLE);

    await openSessionsSubmenu();

    const closeCompleted = window.getByRole("menuitem", { name: /Close Completed/ });
    await expect(closeCompleted).toBeVisible({ timeout: T_SHORT });
    await expect(closeCompleted).toHaveAttribute("data-disabled", { timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
  });

  test("close all with cancel preserves terminals", async () => {
    const { window } = ctx;

    await window.waitForTimeout(T_SETTLE);

    const gridBefore = await getGridPanelCount(window);
    const dockBefore = await getDockPanelCount(window);

    await openSessionsSubmenu();
    await clickSessionsItem(/Close All \(Trash\)/);

    const dialog = window.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible({ timeout: T_SHORT });

    expect(await getGridPanelCount(window)).toBe(gridBefore);
    expect(await getDockPanelCount(window)).toBe(dockBefore);
  });

  test("close all with confirm removes all terminals", async () => {
    const { window } = ctx;

    await window.waitForTimeout(T_SETTLE);

    await openSessionsSubmenu();
    await clickSessionsItem(/Close All \(Trash\)/);

    const dialog = window.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    await dialog.getByRole("button", { name: "Confirm" }).click();

    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);
    await expect.poll(() => getDockPanelCount(window), { timeout: T_LONG }).toBe(0);
  });
});
