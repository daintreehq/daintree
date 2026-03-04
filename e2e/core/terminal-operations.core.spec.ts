import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getFirstGridPanel, getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;

test.describe.serial("Terminal Operations", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({ name: "terminal-ops" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Terminal Ops");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("open terminal via toolbar", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.openTerminal).click();
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });
  });

  test("rename terminal by editing title", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);

    const titleBtn = panel.locator('[role="button"][aria-label*="Terminal title"]').first();
    await expect(titleBtn).toBeVisible({ timeout: T_MEDIUM });

    await titleBtn.click();
    await window.keyboard.press("Enter");

    const titleInput = panel.locator("input").first();
    await expect(titleInput).toBeVisible({ timeout: T_SHORT });

    await titleInput.fill("My Custom Terminal");
    await window.keyboard.press("Enter");

    await expect(panel.locator('[role="button"][aria-label*="My Custom Terminal"]')).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("duplicate terminal as new tab", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);

    const duplicateBtn = panel.locator(SEL.panel.duplicate).first();
    await duplicateBtn.click({ force: true, timeout: T_MEDIUM });

    const tabList = panel.locator(SEL.panel.tabList);
    await expect(tabList).toBeVisible({ timeout: T_MEDIUM });

    const tabs = tabList.locator(SEL.panel.tab);
    await expect(tabs).toHaveCount(2, { timeout: T_MEDIUM });

    const count = await getGridPanelCount(window);
    expect(count).toBe(1);
  });

  test("restart terminal session", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);

    const restartBtn = panel.locator(SEL.panel.restart).first();
    await restartBtn.click({ force: true });

    await window.waitForTimeout(300);
    await restartBtn.click({ force: true });

    await expect(panel).toBeVisible({ timeout: T_LONG });
  });

  test("close all tabs leaves empty grid", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);

    const closeBtn = panel.locator(SEL.panel.close).first();
    await closeBtn.click();

    await window.waitForTimeout(500);
    const remaining = await getGridPanelCount(window);
    if (remaining > 0) {
      const panel2 = getFirstGridPanel(window);
      const closeBtn2 = panel2.locator(SEL.panel.close).first();
      await closeBtn2.click();
    }

    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
  });
});
