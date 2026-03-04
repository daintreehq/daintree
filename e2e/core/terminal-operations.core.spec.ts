import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFirstGridPanel, getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";

let ctx: AppContext;

test.describe.serial("Terminal Operations", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({ name: "terminal-ops" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Terminal Ops");
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("open terminal via toolbar", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.openTerminal).click();
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: 10_000 });
  });

  test("rename terminal by editing title", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);

    // The title is a <span role="button"> with aria-label like "Terminal title: Terminal. Press Enter or F2 to edit"
    const titleBtn = panel.locator('[role="button"][aria-label*="Terminal title"]').first();
    await expect(titleBtn).toBeVisible({ timeout: 5_000 });

    // Click to focus, then Enter to enter edit mode
    await titleBtn.click();
    await window.keyboard.press("Enter");

    // An input should appear for editing
    const titleInput = panel.locator("input").first();
    await expect(titleInput).toBeVisible({ timeout: 3_000 });

    await titleInput.fill("My Custom Terminal");
    await window.keyboard.press("Enter");

    // Verify the title updated
    await expect(panel.locator('[role="button"][aria-label*="My Custom Terminal"]')).toBeVisible({
      timeout: 3_000,
    });
  });

  test("duplicate terminal as new tab", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);

    // Action buttons are hidden via CSS opacity; use force:true to click
    const duplicateBtn = panel.locator(SEL.panel.duplicate).first();
    await duplicateBtn.click({ force: true, timeout: 5_000 });

    // Should now have a tab list with 2 tabs
    const tabList = panel.locator(SEL.panel.tabList);
    await expect(tabList).toBeVisible({ timeout: 5_000 });

    const tabs = tabList.locator(SEL.panel.tab);
    await expect(tabs).toHaveCount(2, { timeout: 5_000 });

    // Still only 1 grid panel (tabs are within the same panel)
    const count = await getGridPanelCount(window);
    expect(count).toBe(1);
  });

  test("restart terminal session", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);

    // Action buttons are hidden via CSS opacity; use force:true to click
    const restartBtn = panel.locator(SEL.panel.restart).first();
    await restartBtn.click({ force: true });

    // Restart uses a 2-click confirmation — click again to confirm
    await window.waitForTimeout(300);
    await restartBtn.click({ force: true });

    // Terminal should still be visible after restart
    await expect(panel).toBeVisible({ timeout: 10_000 });
  });

  test("close all tabs leaves empty grid", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);

    // Close the first tab via close button in panel header
    const closeBtn = panel.locator(SEL.panel.close).first();
    await closeBtn.click();

    // There may still be the second tab, close it too
    await window.waitForTimeout(500);
    const remaining = await getGridPanelCount(window);
    if (remaining > 0) {
      const panel2 = getFirstGridPanel(window);
      const closeBtn2 = panel2.locator(SEL.panel.close).first();
      await closeBtn2.click();
    }

    await expect.poll(() => getGridPanelCount(window), { timeout: 5_000 }).toBe(0);
  });
});
