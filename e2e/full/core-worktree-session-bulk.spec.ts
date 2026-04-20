import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount, getDockPanelCount } from "../helpers/panels";
import { spawnTerminalAndVerify } from "../helpers/workflows";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
const FEATURE = "feature/test-branch";

test.describe.serial("Core: Worktree Session Bulk", () => {
  test.beforeAll(async () => {
    const fixture = createFixtureRepo({
      name: "worktree-session-bulk",
      withFeatureBranch: true,
    });

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture, "Session Bulk");
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
    // Hover doesn't reliably open Radix submenus on Linux CI. Click the
    // trigger so the submenu opens on all platforms.
    await sessionsTrigger.click();
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
});
