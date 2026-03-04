import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFirstGridPanel, getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";

let ctx: AppContext;

test.describe.serial("Multi-Panel Grid & Dock", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({ name: "multi-panel" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Multi Panel Test");
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("open 3 terminals via toolbar", async () => {
    const { window } = ctx;

    for (let i = 0; i < 3; i++) {
      await window.locator(SEL.toolbar.openTerminal).click();
      await window.waitForTimeout(500);
    }

    await expect.poll(() => getGridPanelCount(window), { timeout: 10_000 }).toBe(3);
  });

  test("grid shows 3 panels simultaneously", async () => {
    const { window } = ctx;

    const panels = window.locator(SEL.panel.gridPanel);
    await expect(panels).toHaveCount(3);

    // All 3 should be visible
    for (let i = 0; i < 3; i++) {
      await expect(panels.nth(i)).toBeVisible();
    }
  });

  test("minimize first panel to dock", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);
    // Action buttons are hidden via CSS opacity; use force:true to click
    const minimizeBtn = panel.locator(SEL.panel.minimize).first();
    await minimizeBtn.click({ force: true });

    await expect.poll(() => getGridPanelCount(window), { timeout: 5_000 }).toBe(2);

    // Dock should be visible
    const dock = window.locator(SEL.dock.container);
    await expect(dock).toBeVisible({ timeout: 3_000 });
  });

  test("minimize second panel to dock", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);
    const minimizeBtn = panel.locator(SEL.panel.minimize).first();
    await minimizeBtn.click({ force: true });

    await expect.poll(() => getGridPanelCount(window), { timeout: 5_000 }).toBe(1);
  });

  test("dock has 2 items, grid has 1", async () => {
    const { window } = ctx;

    const gridCount = await getGridPanelCount(window);
    expect(gridCount).toBe(1);

    // Dock should have buttons for the 2 minimized panels
    const dock = window.locator(SEL.dock.container);
    const dockButtons = dock.locator("button");
    const dockCount = await dockButtons.count();
    expect(dockCount).toBeGreaterThanOrEqual(2);
  });

  test("restore one panel from dock", async () => {
    const { window } = ctx;

    const dock = window.locator(SEL.dock.container);
    const dockItem = dock.locator("button").first();
    await dockItem.dblclick();

    await expect.poll(() => getGridPanelCount(window), { timeout: 5_000 }).toBe(2);
  });

  test("open dev preview panel", async () => {
    const { window } = ctx;

    const devBtn = window.locator(SEL.toolbar.openDevPreview);
    if (!(await devBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    const before = await getGridPanelCount(window);
    await devBtn.click();

    await expect.poll(() => getGridPanelCount(window), { timeout: 10_000 }).toBe(before + 1);
  });

  test("close all panels leaves empty grid", async () => {
    const { window } = ctx;

    // Close all panels one by one
    let count = await getGridPanelCount(window);
    while (count > 0) {
      const panel = getFirstGridPanel(window);
      const closeBtn = panel.locator(SEL.panel.close).first();
      await closeBtn.click({ force: true });
      await expect.poll(() => getGridPanelCount(window), { timeout: 5_000 }).toBe(count - 1);
      count--;
    }

    expect(await getGridPanelCount(window)).toBe(0);
  });
});
