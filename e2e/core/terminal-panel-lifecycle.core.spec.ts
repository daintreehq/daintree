import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;

test.describe.serial("Terminal Panel Lifecycle", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({ name: "terminal-test" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Terminal Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("open terminal via toolbar button", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.openTerminal).click();

    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });
  });

  test("run command and verify output", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);
    await runTerminalCommand(window, panel, "node -e \"console.log('CANOPY_E2E_OK')\"");
    await waitForTerminalText(panel, "CANOPY_E2E_OK", T_LONG);
  });

  test("maximize and unmaximize panel", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);

    const maximizeBtn = panel.locator('[aria-label*="Maximize"]').first();
    await maximizeBtn.click();

    const exitFocus = window.locator('[aria-label*="Exit Focus"]').first();
    await expect(exitFocus).toBeVisible({ timeout: T_SHORT });

    await exitFocus.click();
    await expect(exitFocus).not.toBeVisible({ timeout: T_SHORT });
  });

  test("minimize to dock and restore", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);
    const minimizeBtn = panel.locator(SEL.panel.minimize).first();
    await minimizeBtn.click();

    await expect(panel).not.toBeVisible({ timeout: T_SHORT });

    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);

    const dock = window.locator(SEL.dock.container);
    await expect(dock).toBeVisible({ timeout: T_SHORT });

    const dockItem = dock.locator("button").first();
    await dockItem.dblclick();

    await expect(getFirstGridPanel(window)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("close terminal session", async () => {
    const { window } = ctx;

    const panel = getFirstGridPanel(window);
    const closeBtn = panel.locator(SEL.panel.close);
    await closeBtn.click();

    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
  });
});
