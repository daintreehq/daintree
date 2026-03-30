import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import {
  getGridPanelCount,
  getFirstGridPanel,
  getFocusedPanelId,
  getGridPanelIds,
} from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";
import { expectTerminalFocused, ensureWindowFocused } from "../helpers/focus";

let ctx: AppContext;
const mod = process.platform === "darwin" ? "Meta" : "Control";

test.describe.serial("Core: Focus Management", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "focus-management" });
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Focus Management Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("action palette dismiss restores terminal focus", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    // Click the main content area to ensure the app has keyboard focus
    await window.locator("main").click({ force: true });
    await window.waitForTimeout(200);

    const before = await getGridPanelCount(window);
    await window.keyboard.press(`${mod}+Alt+t`);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
    await window
      .locator(SEL.terminal.xtermRows)
      .first()
      .waitFor({ state: "visible", timeout: T_LONG });

    const panel = getFirstGridPanel(window);
    await panel.locator(SEL.terminal.xtermRows).click();
    await expectTerminalFocused(panel);

    await window.keyboard.press(`${mod}+Shift+P`);
    await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.actionPalette.searchInput)).toBeFocused({ timeout: T_SHORT });
    // Settle to let any delayed menu IPC arrive before dismissing
    await window.waitForTimeout(T_SETTLE);

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
    await expectTerminalFocused(panel, T_MEDIUM);
  });

  test("quick switcher dismiss restores terminal focus", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    const panel = getFirstGridPanel(window);
    await panel.locator(SEL.terminal.xtermRows).click();
    await expectTerminalFocused(panel);

    await window.keyboard.press(`${mod}+P`);
    await expect(window.locator(SEL.quickSwitcher.dialog)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.quickSwitcher.searchInput)).toBeFocused({ timeout: T_SHORT });
    // Settle to let any delayed menu IPC arrive before dismissing
    await window.waitForTimeout(T_SETTLE);

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.quickSwitcher.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
    await expectTerminalFocused(panel, T_MEDIUM);
  });

  test("F6 cycles focus between macro regions", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    const panel = getFirstGridPanel(window);
    await panel.locator(SEL.terminal.xtermRows).click();
    await expectTerminalFocused(panel);

    // First F6 from terminal: focusedRegion is null → targets "grid" (first visible region)
    await window.keyboard.press("F6");
    // The grid region may have aria-label "Panel grid" or "Panel grid region"
    const grid = window.locator('[role="region"]').filter({
      has: window.locator('[data-grid-container="true"]'),
    });
    await expect(grid).toBeFocused({ timeout: T_MEDIUM });

    // Second F6: grid → sidebar
    await window.keyboard.press("F6");
    const sidebar = window.locator('[aria-label="Sidebar"]');
    await expect(sidebar).toBeFocused({ timeout: T_MEDIUM });

    // Third F6: sidebar → grid (wraps around)
    await window.keyboard.press("F6");
    await expect(grid).toBeFocused({ timeout: T_MEDIUM });
  });

  test("clicking panels changes focused panel ID", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    const before = await getGridPanelCount(window);
    await window.keyboard.press(`${mod}+Alt+t`);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
    await window
      .locator(SEL.panel.gridPanel)
      .last()
      .locator(SEL.terminal.xtermRows)
      .waitFor({ state: "visible", timeout: T_LONG });

    const ids = await getGridPanelIds(window);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    // Click the first panel and verify it's focused
    const firstPanel = window.locator(SEL.panel.gridPanel).first();
    await firstPanel.locator(SEL.terminal.xtermRows).click();
    await expectTerminalFocused(firstPanel);
    const firstId = await getFocusedPanelId(window);
    expect(firstId).toBeTruthy();

    // Click the second panel and verify focus moves
    const secondPanel = window.locator(SEL.panel.gridPanel).last();
    await secondPanel.locator(SEL.terminal.xtermRows).click();
    await expectTerminalFocused(secondPanel);
    const secondId = await getFocusedPanelId(window);
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);

    // Clean up: close the extra panel
    const panelToClose = window.locator(SEL.panel.gridPanel).last();
    await panelToClose.locator(SEL.panel.close).first().click({ force: true });
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before);
  });

  test("Escape pops layered overlays in LIFO order", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    const panel = getFirstGridPanel(window);
    await panel.locator(SEL.terminal.xtermRows).click();
    await expectTerminalFocused(panel);

    // Open Settings first (bottom of stack)
    await window.keyboard.press(`${mod}+,`);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    // Open Action Palette on top (top of stack)
    await window.keyboard.press(`${mod}+Shift+P`);
    await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
    // Settle to let any delayed menu IPC arrive before dismissing
    await window.waitForTimeout(T_SETTLE);

    // First Escape: palette closes, settings stays
    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });

    // Second Escape: settings closes
    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

    // Focus restored to terminal
    await expectTerminalFocused(panel, T_MEDIUM);
  });
});
