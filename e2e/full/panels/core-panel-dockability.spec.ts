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

test.describe.serial("Core: Panel dockability", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "panel-dockability" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Non PTY Dock");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("terminal and browser panels both expose move-to-dock", async () => {
    const { window } = ctx;

    await test.step("A terminal panel shows the move-to-dock control", async () => {
      await openTerminal(window);
      const terminal = getFirstGridPanel(window);
      await expect(terminal).toBeVisible({ timeout: T_LONG });
      await terminal.hover();
      // PTY-backed panels get the dock affordance.
      await expect(terminal.locator(SEL.panel.minimize)).toBeVisible({ timeout: T_SHORT });
    });

    await test.step("A browser panel shows the move-to-dock control (#11053)", async () => {
      await openBrowser(window);
      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_LONG })
        .toBeGreaterThanOrEqual(2);

      // Locate the grid panel that hosts the browser surface (address bar).
      const browserPanel = window
        .locator(SEL.panel.gridPanel)
        .filter({ has: window.locator(SEL.browser.addressBar) });
      await expect(browserPanel).toHaveCount(1, { timeout: T_MEDIUM });

      // browser is now a dockable reading surface (panelKindIsDockable), so the
      // dock affordance renders — the panel can leave the grid without vanishing.
      await browserPanel.hover();
      await expect(browserPanel.locator(SEL.panel.minimize)).toBeVisible({ timeout: T_SHORT });
      // It still has the standard close affordance, confirming this is a real
      // panel header and not a missing-panel false negative.
      await expect(browserPanel.locator(SEL.panel.close)).toHaveCount(1);
    });
  });
});
