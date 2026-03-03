import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";

let ctx: AppContext;

test.describe.serial("Terminal Panel Lifecycle", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({ name: "terminal-test" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Terminal Test");
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("open terminal via toolbar button", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.openTerminal).click();

    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: 10_000 });
  });

  test("run command and verify output", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);
    await runTerminalCommand(window, panel, "node -e \"console.log('CANOPY_E2E_OK')\"");
    await waitForTerminalText(panel, "CANOPY_E2E_OK", 15_000);
  });

  test("maximize and unmaximize panel", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);

    // Find maximize button within the panel header
    const maximizeBtn = panel.locator('[aria-label*="Maximize"]').first();
    await maximizeBtn.click();

    // Should show Exit Focus button
    const exitFocus = window.locator('[aria-label*="Exit Focus"]').first();
    await expect(exitFocus).toBeVisible({ timeout: 3_000 });

    await exitFocus.click();
    await expect(exitFocus).not.toBeVisible({ timeout: 3_000 });
  });

  test("minimize to dock and restore", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);
    const minimizeBtn = panel.locator(SEL.panel.minimize).first();
    await minimizeBtn.click();

    // Wait for panel to move to dock
    await expect(panel).not.toBeVisible({ timeout: 3_000 });

    // Grid should be empty
    await expect.poll(() => getGridPanelCount(window), { timeout: 5_000 }).toBe(0);

    // Dock should be visible
    const dock = window.locator(SEL.dock.container);
    await expect(dock).toBeVisible({ timeout: 3_000 });

    // Double-click dock item to restore to grid
    const dockItem = dock.locator("button").first();
    await dockItem.dblclick();

    // Panel should be back in grid
    await expect(getFirstGridPanel(window)).toBeVisible({ timeout: 5_000 });
  });

  test("close terminal session", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);
    const closeBtn = panel.locator(SEL.panel.close);
    await closeBtn.click();

    // Panel removal is async — poll until grid is empty
    await expect.poll(() => getGridPanelCount(window), { timeout: 5_000 }).toBe(0);
  });
});
