import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import { expectTerminalFocused } from "../helpers/focus";
import { getFirstGridPanel } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: SAB Fallback (IPC-only terminal output)", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "sab-fallback" });
    ctx = await launchApp({
      extraArgs: ["--disable-features=SharedArrayBuffer"],
    });
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "SAB Fallback Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("opens a terminal with SAB disabled", async () => {
    const { window } = ctx;
    await window.locator(SEL.toolbar.openTerminal).click();
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });
  });

  test("renders command output via IPC fallback", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);
    await runTerminalCommand(window, panel, "node -e \"console.log('SAB_FALLBACK_OK')\"");
    await waitForTerminalText(panel, "SAB_FALLBACK_OK", T_LONG);
  });

  test("find-in-panel works in IPC-only mode", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);

    await panel.locator(SEL.terminal.xtermRows).click();
    await window.waitForTimeout(T_SETTLE);
    await expectTerminalFocused(panel);
    await window.evaluate(() => window.dispatchEvent(new CustomEvent("canopy:find-in-panel")));

    const searchInput = panel.locator(SEL.terminal.searchInput);
    await expect(searchInput).toBeVisible({ timeout: T_MEDIUM });

    await searchInput.fill("SAB_FALLBACK_OK");
    await window.waitForTimeout(T_SETTLE);

    await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Found", {
      timeout: T_MEDIUM,
    });

    await searchInput.focus();
    await window.keyboard.press("Escape");
    await expect(searchInput).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("renders 150 lines of multi-line output", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);

    await runTerminalCommand(
      window,
      panel,
      "node -e \"console.log('MULTI_TOP'); for(let i=1;i<=150;i++) console.log(i); console.log('MULTI_BOTTOM')\""
    );
    await waitForTerminalText(panel, "MULTI_BOTTOM", T_LONG);

    await panel.locator(SEL.terminal.xtermRows).click();
    await window.waitForTimeout(T_SETTLE);

    for (let i = 0; i < 15; i++) {
      await window.keyboard.press("Shift+PageUp");
    }
    await window.waitForTimeout(T_SETTLE);

    await waitForTerminalText(panel, "MULTI_TOP", T_MEDIUM);
  });
});
