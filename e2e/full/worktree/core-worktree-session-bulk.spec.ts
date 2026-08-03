import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount, getDockPanelCount } from "../../helpers/panels";
import { spawnTerminalAndVerify } from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;
const FEATURE = "feature/test-branch";

test.describe.serial("Core: Worktree Session Bulk", () => {
  test.beforeAll(async () => {
    const { dir: fixture, cleanup } = createFixtureRepo({
      name: "worktree-session-bulk",
      withFeatureBranch: true,
    });
    fixtureCleanup = cleanup;

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture, "Session Bulk");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
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

  async function expectWorktreeSessionSummary(count: number) {
    const { window } = ctx;
    const featureCard = window.locator(SEL.worktree.card(FEATURE));
    await expect
      .poll(
        async () => {
          const text = (await featureCard.textContent()) ?? "";
          return text.replace(/\s+/g, "").toLowerCase();
        },
        { timeout: T_LONG }
      )
      .toContain(`${count}active`);
  }

  async function expectSessionsItemCount(name: string | RegExp, count: number) {
    const { window } = ctx;
    const item = window.getByRole("menuitem", { name });
    await expect(item).toBeVisible({ timeout: T_SHORT });
    await expect(item).toContainText(`(${count})`, { timeout: T_LONG });
    await expect(item).not.toHaveAttribute("aria-disabled", "true", { timeout: T_LONG });
  }

  async function clickSessionsItem(name: string | RegExp) {
    const { window } = ctx;
    const item = window.getByRole("menuitem", { name });
    await expect(item).toBeVisible({ timeout: T_SHORT });
    await expect(item).not.toHaveAttribute("aria-disabled", "true", { timeout: T_LONG });
    await item.click();
  }

  test("select feature worktree and spawn 3 terminals", async () => {
    const { window } = ctx;

    const featureCard = window.locator(SEL.worktree.card(FEATURE));
    await featureCard.click({ position: { x: 10, y: 10 } });
    await expect(window.locator(SEL.worktree.row(FEATURE))).toHaveAttribute(
      "aria-current",
      "true",
      { timeout: T_LONG }
    );

    await spawnTerminalAndVerify(window);
    await spawnTerminalAndVerify(window);
    await spawnTerminalAndVerify(window);

    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);
    await expect.poll(() => getDockPanelCount(window), { timeout: T_LONG }).toBe(0);
    await expectWorktreeSessionSummary(3);
  });

  test("dock all sessions", async () => {
    const { window } = ctx;

    await expectWorktreeSessionSummary(3);
    await openSessionsSubmenu();
    await expectSessionsItemCount(/Dock All/, 3);
    await clickSessionsItem(/Dock All/);

    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);
    await expect.poll(() => getDockPanelCount(window), { timeout: T_LONG }).toBe(3);
    await expectWorktreeSessionSummary(3);
  });

  test("maximize all sessions", async () => {
    const { window } = ctx;

    await window.waitForTimeout(T_SETTLE);

    await expectWorktreeSessionSummary(3);
    await openSessionsSubmenu();
    await expectSessionsItemCount(/Maximize All/, 3);
    await clickSessionsItem(/Maximize All/);

    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);
    await expect.poll(() => getDockPanelCount(window), { timeout: T_LONG }).toBe(0);
  });
});
