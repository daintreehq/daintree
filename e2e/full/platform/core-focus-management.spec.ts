import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getGridPanelCount,
  getFirstGridPanel,
  getFocusedPanelId,
  getGridPanelIds,
  openBrowser,
} from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";
import { expectTerminalFocused, ensureWindowFocused } from "../../helpers/focus";

let ctx: AppContext;
const mod = process.platform === "darwin" ? "Meta" : "Control";
let fixtureCleanup: (() => void) | undefined;

async function openQuickSwitcher(window: Page): Promise<void> {
  if (process.platform === "darwin") {
    await window.keyboard.press(`${mod}+P`);
    return;
  }
  await window.evaluate(() =>
    (
      window as unknown as {
        __daintreeDispatchAction: (actionId: string) => Promise<unknown>;
      }
    ).__daintreeDispatchAction("nav.quickSwitcher")
  );
}

test.describe.serial("Core: Focus Management", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "focus-management" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Focus Management Test"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("action palette dismiss restores terminal focus", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    let panel: ReturnType<typeof getFirstGridPanel>;

    await test.step("Open a terminal and focus it", async () => {
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

      panel = getFirstGridPanel(window);
      await panel.locator(SEL.terminal.xtermRows).click();
      await expectTerminalFocused(panel);
    });

    await test.step("Open action palette and verify search input is focused", async () => {
      await window.keyboard.press(`${mod}+Shift+P`);
      await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.locator(SEL.actionPalette.searchInput)).toBeFocused({ timeout: T_SHORT });
      // Settle to let any delayed menu IPC arrive before dismissing
      await window.waitForTimeout(T_SETTLE);
    });

    await test.step("Dismiss palette and verify terminal focus is restored", async () => {
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
      await expectTerminalFocused(panel!, T_MEDIUM);
    });
  });

  test("quick switcher dismiss restores terminal focus", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);
    const panel = getFirstGridPanel(window);

    await test.step("Focus terminal panel", async () => {
      await panel.locator(SEL.terminal.xtermRows).click();
      await expectTerminalFocused(panel);
    });

    await test.step("Open quick switcher and verify search input is focused", async () => {
      await openQuickSwitcher(window);
      await expect(window.locator(SEL.quickSwitcher.dialog)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.locator(SEL.quickSwitcher.searchInput)).toBeFocused({ timeout: T_SHORT });
      // Settle to let any delayed menu IPC arrive before dismissing
      await window.waitForTimeout(T_SETTLE);
    });

    await test.step("Dismiss switcher and verify terminal focus is restored", async () => {
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.quickSwitcher.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
      await expectTerminalFocused(panel, T_MEDIUM);
    });
  });

  test("F6 cycles focus between macro regions", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);
    const panel = getFirstGridPanel(window);
    const grid = window.locator('[role="region"]').filter({
      has: window.locator('[data-grid-container="true"]'),
    });
    const sidebar = window.locator('[aria-label="Sidebar"]');

    await test.step("Focus terminal panel as starting region", async () => {
      await panel.locator(SEL.terminal.xtermRows).click();
      await expectTerminalFocused(panel);
    });

    await test.step("First F6: terminal → grid region", async () => {
      // First F6 from terminal: focusedRegion is null → targets "grid" (first visible region)
      await window.keyboard.press("F6");
      // The grid region has aria-label "Panels" across all layout variants
      await expect(grid).toBeFocused({ timeout: T_MEDIUM });
    });

    await test.step("Second F6: grid → sidebar", async () => {
      await window.keyboard.press("F6");
      await expect(sidebar).toBeFocused({ timeout: T_MEDIUM });
    });

    await test.step("Third F6: sidebar → grid (wraps around)", async () => {
      await window.keyboard.press("F6");
      await expect(grid).toBeFocused({ timeout: T_MEDIUM });
    });
  });

  test("clicking panels changes focused panel ID", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);
    let before = 0;

    await test.step("Open a second terminal so two panels are present", async () => {
      before = await getGridPanelCount(window);
      await window.keyboard.press(`${mod}+Alt+t`);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
      await window
        .locator(SEL.panel.gridPanel)
        .last()
        .locator(SEL.terminal.xtermRows)
        .waitFor({ state: "visible", timeout: T_LONG });

      const ids = await getGridPanelIds(window);
      expect(ids.length).toBeGreaterThanOrEqual(2);
    });

    let firstId: string | null = null;
    await test.step("Click first panel and capture focused panel id", async () => {
      const firstPanel = window.locator(SEL.panel.gridPanel).first();
      await firstPanel.locator(SEL.terminal.xtermRows).click();
      await expectTerminalFocused(firstPanel);
      firstId = await getFocusedPanelId(window);
      expect(firstId).toBeTruthy();
    });

    await test.step("Click second panel and verify focused panel id changes", async () => {
      const secondPanel = window.locator(SEL.panel.gridPanel).last();
      await secondPanel.locator(SEL.terminal.xtermRows).click();
      await expectTerminalFocused(secondPanel);
      const secondId = await getFocusedPanelId(window);
      expect(secondId).toBeTruthy();
      expect(secondId).not.toBe(firstId);
    });

    await test.step("Clean up extra panel created during this test", async () => {
      const panelToClose = window.locator(SEL.panel.gridPanel).last();
      await panelToClose.locator(SEL.panel.close).first().click({ force: true });
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before);
    });
  });

  test("Escape pops layered overlays in LIFO order", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);
    let panel = getFirstGridPanel(window);

    await test.step("Focus terminal as the underlying focus target", async () => {
      if (
        !(await panel
          .locator(SEL.terminal.xtermRows)
          .isVisible({ timeout: 1000 })
          .catch(() => false))
      ) {
        const before = await getGridPanelCount(window);
        await window.keyboard.press(`${mod}+Alt+t`);
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThan(before);
        panel = window
          .locator(SEL.panel.gridPanel)
          .filter({ has: window.locator(SEL.terminal.xtermRows) })
          .last();
        await expect(panel.locator(SEL.terminal.xtermRows)).toBeVisible({ timeout: T_LONG });
      }
      await panel.locator(SEL.terminal.xtermRows).click();
      await expectTerminalFocused(panel);
    });

    await test.step("Open Settings (bottom of stack), then Action Palette (top)", async () => {
      await window.keyboard.press(`${mod}+,`);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      await window.keyboard.press(`${mod}+Shift+P`);
      await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
      // Settle to let any delayed menu IPC arrive before dismissing
      await window.waitForTimeout(T_SETTLE);
    });

    await test.step("First Escape pops palette only — settings remains", async () => {
      await window.keyboard.press("Escape");
      const paletteDialog = window.locator(SEL.actionPalette.dialog);
      await expect(paletteDialog).not.toBeVisible({ timeout: T_MEDIUM });
      await expect(paletteDialog).toHaveCount(0, { timeout: T_MEDIUM });
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });
    });

    await test.step("Second Escape closes settings and restores terminal focus", async () => {
      await window.locator(SEL.settings.heading).click({ force: true });
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

      // Focus restored to terminal
      await expectTerminalFocused(panel, T_MEDIUM);
    });
  });

  test("Enter from the grid region enters a non-PTY panel", async () => {
    const { window } = ctx;
    await ensureWindowFocused(ctx.app);

    const grid = window.locator('[role="region"]').filter({
      has: window.locator('[data-grid-container="true"]'),
    });
    let before = 0;
    let browserPanel: ReturnType<typeof getFirstGridPanel>;
    let browserId: string | null = null;

    await test.step("Open a browser panel and make it the focused panel", async () => {
      before = await getGridPanelCount(window);
      await openBrowser(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);

      browserPanel = window.locator(SEL.panel.gridPanel).last();
      browserId = await browserPanel.getAttribute("data-panel-id");
      expect(browserId).toBeTruthy();

      // Click the panel's title bar (top-left, clear of the embedded web view)
      // rather than relying on new panels being auto-focused: it pins
      // `focusedId` AND puts document.activeElement inside the panel, so
      // getFocusedPanelId resolves without depending on the multi-panel
      // `.terminal-selected` fallback.
      await browserPanel.click({ force: true, position: { x: 12, y: 8 } });
      await expect.poll(() => getFocusedPanelId(window), { timeout: T_MEDIUM }).toBe(browserId);
    });

    await test.step("F6 lifts focus to the grid macro region", async () => {
      await window.keyboard.press("F6");
      await expect(grid).toBeFocused({ timeout: T_MEDIUM });
    });

    await test.step("Enter moves focus into the browser panel (#11109)", async () => {
      // This Enter used to no-op: the handler only ever reached a live xterm,
      // so every non-PTY kind swallowed the key and focus stayed on the grid.
      await window.keyboard.press("Enter");
      await expect(browserPanel).toBeFocused({ timeout: T_MEDIUM });
      await expect(grid).not.toBeFocused();
    });

    await test.step("Clean up the browser panel", async () => {
      // No force: it skips the actionability and stability wait, so the click
      // lands at stale coordinates while the panel is still settling and misses
      // the close button entirely.
      await browserPanel.locator(SEL.panel.close).first().click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before);
    });
  });
});
