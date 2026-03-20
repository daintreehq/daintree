import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Panel Tab Groups", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "tab-groups", withMultipleFiles: true });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Tab Groups Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Tab Group Lifecycle ─────────────────────────────────

  test.describe.serial("Tab Group Lifecycle", () => {
    test("open terminal and run marker command", async () => {
      const { window } = ctx;
      await window.locator(SEL.toolbar.openTerminal).click();
      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });

      await runTerminalCommand(window, panel, "node -e \"console.log('TAB_ORIGINAL_MARKER')\"");
      await waitForTerminalText(panel, "TAB_ORIGINAL_MARKER", T_LONG);
    });

    test("duplicate creates tab group with 2 tabs", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      // The + button has opacity-0 on single panels, use force:true
      const duplicateBtn = panel.locator(SEL.panel.duplicate).first();
      await duplicateBtn.click({ force: true, timeout: T_MEDIUM });

      const tabList = panel.locator(SEL.panel.tabList);
      await expect(tabList).toBeVisible({ timeout: T_MEDIUM });

      const tabs = tabList.locator(SEL.panel.tab);
      await expect(tabs).toHaveCount(2, { timeout: T_MEDIUM });

      // Still only 1 grid panel (tabs are within the same panel)
      expect(await getGridPanelCount(window)).toBe(1);
    });

    test("duplicated tab inherits cwd and has functional PTY", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      // The duplicated tab should be the active one — verify PTY works
      await runTerminalCommand(window, panel, "node -e \"console.log('TAB_DUPLICATE_ALIVE')\"");
      await waitForTerminalText(panel, "TAB_DUPLICATE_ALIVE", T_LONG);

      // Verify working directory is inherited
      await runTerminalCommand(window, panel, 'node -p "process.cwd()"');
      const dirBasename = fixtureDir.split("/").pop() || fixtureDir.split("\\").pop() || "";
      await waitForTerminalText(panel, dirBasename, T_LONG);
    });

    test("clicking tab switches active terminal", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);
      const tabList = panel.locator(SEL.panel.tabList);
      const tabs = tabList.locator(SEL.panel.tab);

      // Click the first tab (the original terminal)
      await tabs.first().click();
      await expect(tabs.first()).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });

      // The original marker should be visible in this terminal
      await waitForTerminalText(panel, "TAB_ORIGINAL_MARKER", T_LONG);
    });

    test("maximize and restore preserves tab group", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      const maximizeBtn = panel.locator(SEL.panel.maximize).first();
      await maximizeBtn.click();

      const exitFocus = window.locator(SEL.panel.exitFocus).first();
      await expect(exitFocus).toBeVisible({ timeout: T_SHORT });

      await exitFocus.click();
      await expect(exitFocus).not.toBeVisible({ timeout: T_SHORT });

      // Tab list should still be visible with 2 tabs
      const tabList = panel.locator(SEL.panel.tabList);
      await expect(tabList).toBeVisible({ timeout: T_SHORT });
      const tabs = tabList.locator(SEL.panel.tab);
      await expect(tabs).toHaveCount(2, { timeout: T_SHORT });
    });

    test("closing one tab keeps panel open and removes tab bar", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);
      const tabList = panel.locator(SEL.panel.tabList);
      const tabs = tabList.locator(SEL.panel.tab);

      // Close the second tab (index 1) via its close button
      const secondTab = tabs.nth(1);
      const closeBtn = secondTab.locator('button[aria-label^="Close"]');
      await closeBtn.click({ force: true });

      // Tab list should disappear (only 1 tab remaining)
      await expect(tabList).not.toBeVisible({ timeout: T_MEDIUM });

      // Panel should still be visible
      await expect(panel).toBeVisible({ timeout: T_SHORT });
      expect(await getGridPanelCount(window)).toBe(1);
    });

    test("closing last panel removes it from grid", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);
      const closeBtn = panel.locator(SEL.panel.close);
      await closeBtn.click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
    });
  });

  // ── Overflow Menu & Restart ─────────────────────────────

  test.describe.serial("Overflow Menu & Restart", () => {
    test("overflow menu shows expected actions", async () => {
      const { window } = ctx;

      // Open a fresh terminal
      await window.locator(SEL.toolbar.openTerminal).click();
      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });

      // Wait for terminal to be ready
      await window.waitForTimeout(T_SETTLE);

      // Open overflow menu
      await panel.hover();
      const overflowBtn = panel.locator(SEL.panel.overflowMenu).first();
      await overflowBtn.click();

      // Verify expected menu items are visible (scoped to window since Radix portals to body)
      const expectedItems = [
        "Restart Session",
        "Rename",
        "Duplicate",
        "Lock Input",
        "View Terminal Info",
        "Trash",
      ];

      for (const itemName of expectedItems) {
        await expect(window.getByRole("menuitem", { name: itemName })).toBeVisible({
          timeout: T_SHORT,
        });
      }

      // Close the menu
      await window.keyboard.press("Escape");
    });

    test("restart confirmation flow works", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      // Run a marker before restart
      await runTerminalCommand(window, panel, "node -e \"console.log('PRE_RESTART')\"");
      await waitForTerminalText(panel, "PRE_RESTART", T_LONG);

      // Open overflow menu and click Restart
      await panel.hover();
      const overflowBtn = panel.locator(SEL.panel.overflowMenu).first();
      await overflowBtn.click();

      const restartBtn = window.locator(SEL.panel.restart).first();
      await expect(restartBtn).toBeVisible({ timeout: T_SHORT });
      await restartBtn.click();

      // Confirm the restart (2-click armed pattern)
      const confirmBtn = window.locator(SEL.panel.restartConfirm).first();
      await expect(confirmBtn).toBeVisible({ timeout: T_SHORT });
      await confirmBtn.click();

      // Panel should remain visible after restart
      await expect(panel).toBeVisible({ timeout: T_LONG });

      // Wait for the new shell to be ready, then verify PTY is functional
      await window.waitForTimeout(T_SETTLE);
      await runTerminalCommand(window, panel, "node -e \"console.log('POST_RESTART_OK')\"");
      await waitForTerminalText(panel, "POST_RESTART_OK", T_LONG);
    });

    test.afterAll(async () => {
      // Best-effort cleanup: close all remaining panels
      const { window } = ctx;
      try {
        let count = await getGridPanelCount(window);
        while (count > 0) {
          const panel = getFirstGridPanel(window);
          await panel.locator(SEL.panel.close).first().click({ force: true });
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
          count--;
        }
      } catch {
        // Best-effort cleanup
      }
    });
  });
});
