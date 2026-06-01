import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getGridPanelCount,
  getFirstGridPanel,
  openTerminal,
  openBrowser,
} from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Non-PTY panels reject the dock", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "non-pty-dock" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Non PTY Dock");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("terminal panels expose move-to-dock, browser panels do not", async () => {
    const { window } = ctx;

    await test.step("A terminal panel shows the move-to-dock control", async () => {
      await openTerminal(window);
      const terminal = getFirstGridPanel(window);
      await expect(terminal).toBeVisible({ timeout: T_LONG });
      await terminal.hover();
      // PTY-backed panels get the dock affordance.
      await expect(terminal.locator(SEL.panel.minimize)).toBeVisible({ timeout: T_SHORT });
    });

    await test.step("A browser panel has no move-to-dock control", async () => {
      await openBrowser(window);
      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_LONG })
        .toBeGreaterThanOrEqual(2);

      // Locate the grid panel that hosts the browser surface (address bar).
      const browserPanel = window
        .locator(SEL.panel.gridPanel)
        .filter({ has: window.locator(SEL.browser.addressBar) });
      await expect(browserPanel).toHaveCount(1, { timeout: T_MEDIUM });

      await browserPanel.hover();
      // showMoveToDock requires `hasPty` — browser panels render no dock button.
      // Rendering it would silently strand the panel (ContentDock filters by isPtyPanel).
      await expect(browserPanel.locator(SEL.panel.minimize)).toHaveCount(0);
      // It still has the standard close affordance, confirming this is a real
      // panel header and not a missing-panel false negative.
      await expect(browserPanel.locator(SEL.panel.close)).toHaveCount(1);
    });
  });
});
