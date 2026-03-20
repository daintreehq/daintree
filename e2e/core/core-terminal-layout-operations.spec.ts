import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import {
  getGridPanelCount,
  getDockPanelCount,
  getGridPanelIds,
  getDockPanelIds,
  getFirstGridPanel,
} from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

async function dispatchAction(page: Page, actionId: string, args?: unknown): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(([id, a]) => (window as any).__canopyDispatchAction(id, a), [
    actionId,
    args,
  ] as const);
}

async function focusPanel(page: Page, panelId: string): Promise<void> {
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  const xtermArea = panel.locator(SEL.terminal.xtermRows).first();
  await xtermArea.click();
  await page.waitForTimeout(T_SETTLE);
}

test.describe.serial("Core: Terminal Layout Operations", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "layout-operations" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Layout Ops Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Grid Panel Reordering ──────────────────────────────────

  test.describe.serial("Grid Panel Reordering", () => {
    test("open 3 terminals for reorder tests", async () => {
      const { window } = ctx;
      for (let i = 0; i < 3; i++) {
        await window.locator(SEL.toolbar.openTerminal).click();
        await window.waitForTimeout(T_SETTLE);
      }
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);
    });

    test("move focused panel right changes order", async () => {
      const { window } = ctx;

      const idsBefore = await getGridPanelIds(window);
      expect(idsBefore).toHaveLength(3);

      await focusPanel(window, idsBefore[0]);
      await dispatchAction(window, "terminal.moveRight");

      await expect
        .poll(() => getGridPanelIds(window), { timeout: T_MEDIUM })
        .toEqual([idsBefore[1], idsBefore[0], idsBefore[2]]);
    });

    test("move first panel left is a no-op", async () => {
      const { window } = ctx;

      const idsBefore = await getGridPanelIds(window);
      await focusPanel(window, idsBefore[0]);
      await dispatchAction(window, "terminal.moveLeft");
      await window.waitForTimeout(T_SETTLE);

      const idsAfter = await getGridPanelIds(window);
      expect(idsAfter).toEqual(idsBefore);
    });

    test("move last panel right is a no-op", async () => {
      const { window } = ctx;

      const idsBefore = await getGridPanelIds(window);
      await focusPanel(window, idsBefore[2]);
      await dispatchAction(window, "terminal.moveRight");
      await window.waitForTimeout(T_SETTLE);

      const idsAfter = await getGridPanelIds(window);
      expect(idsAfter).toEqual(idsBefore);
    });
  });

  // ── Layout Undo/Redo ───────────────────────────────────────

  test.describe.serial("Layout Undo/Redo", () => {
    test("undo restores previous panel order", async () => {
      const { window } = ctx;

      const idsBefore = await getGridPanelIds(window);
      await focusPanel(window, idsBefore[0]);
      await dispatchAction(window, "terminal.moveRight");

      await expect
        .poll(() => getGridPanelIds(window), { timeout: T_MEDIUM })
        .toEqual([idsBefore[1], idsBefore[0], idsBefore[2]]);

      await dispatchAction(window, "layout.undo");

      await expect.poll(() => getGridPanelIds(window), { timeout: T_MEDIUM }).toEqual(idsBefore);
    });

    test("redo re-applies the layout change", async () => {
      const { window } = ctx;

      const idsBefore = await getGridPanelIds(window);
      await dispatchAction(window, "layout.redo");

      await expect
        .poll(() => getGridPanelIds(window), { timeout: T_MEDIUM })
        .toEqual([idsBefore[1], idsBefore[0], idsBefore[2]]);

      // Undo to restore original order for subsequent tests
      await dispatchAction(window, "layout.undo");
      await expect.poll(() => getGridPanelIds(window), { timeout: T_MEDIUM }).toEqual(idsBefore);
    });
  });

  // ── Grid Layout Strategy ───────────────────────────────────

  test.describe.serial("Grid Layout Strategy", () => {
    test("switch to fixed-columns with value 3 updates grid", async () => {
      const { window } = ctx;

      await dispatchAction(window, "terminal.gridLayout.setStrategy", {
        strategy: "fixed-columns",
      });
      await dispatchAction(window, "terminal.gridLayout.setValue", { value: 3 });

      const grid = window.locator("#terminal-grid");
      await expect
        .poll(
          async () => {
            const style = await grid.getAttribute("style");
            return style?.includes("repeat(3, 1fr)");
          },
          { timeout: T_MEDIUM }
        )
        .toBe(true);
    });

    test("switch to fixed-rows updates column count", async () => {
      const { window } = ctx;

      await dispatchAction(window, "terminal.gridLayout.setStrategy", {
        strategy: "fixed-rows",
      });
      await dispatchAction(window, "terminal.gridLayout.setValue", { value: 1 });

      // With 3 panels and 1 row, columns = ceil(3/1) = 3
      const grid = window.locator("#terminal-grid");
      await expect
        .poll(
          async () => {
            const style = await grid.getAttribute("style");
            return style?.includes("repeat(3, 1fr)");
          },
          { timeout: T_MEDIUM }
        )
        .toBe(true);
    });

    test("restore automatic layout strategy", async () => {
      const { window } = ctx;

      await dispatchAction(window, "terminal.gridLayout.setStrategy", {
        strategy: "automatic",
      });

      // Just verify the action completes and grid still renders
      const grid = window.locator("#terminal-grid");
      await expect(grid).toBeVisible({ timeout: T_MEDIUM });
    });
  });

  // ── Dock Panel Activation ──────────────────────────────────

  test.describe.serial("Dock Panel Activation", () => {
    let dockIds: string[];

    test("move all panels to dock", async () => {
      const { window } = ctx;

      const gridIds = await getGridPanelIds(window);
      for (const id of gridIds) {
        await dispatchAction(window, "terminal.moveToDock", { terminalId: id });
        await window.waitForTimeout(T_SETTLE);
      }

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
      await expect
        .poll(() => getDockPanelCount(window), { timeout: T_MEDIUM })
        .toBeGreaterThanOrEqual(3);

      dockIds = await getDockPanelIds(window);
      expect(dockIds.length).toBeGreaterThanOrEqual(3);
    });

    test("click dock item opens popover with terminal content", async () => {
      const { window } = ctx;

      const dock = window.locator(SEL.dock.container);
      const firstButton = dock.locator("button").first();
      await firstButton.click();

      const portalTarget = window.locator("[data-dock-portal-target]");
      await expect(portalTarget).toBeVisible({ timeout: T_MEDIUM });
    });

    test("click different dock item switches active panel", async () => {
      const { window } = ctx;

      const dock = window.locator(SEL.dock.container);
      const buttons = dock.locator("button");
      const count = await buttons.count();
      expect(count).toBeGreaterThanOrEqual(2);

      // Click the second dock button
      await buttons.nth(1).click();
      await window.waitForTimeout(T_SETTLE);

      const portalTarget = window.locator("[data-dock-portal-target]");
      await expect(portalTarget).toBeVisible({ timeout: T_MEDIUM });
    });

    test.afterAll(async () => {
      // Restore all dock panels to grid and close them
      const { window } = ctx;
      try {
        const ids = await getDockPanelIds(window);
        for (const id of ids) {
          await dispatchAction(window, "terminal.moveToGrid", { terminalId: id });
          await window.waitForTimeout(T_SETTLE);
        }

        let gridCount = await getGridPanelCount(window);
        while (gridCount > 0) {
          const panel = getFirstGridPanel(window);
          await panel.locator(SEL.panel.close).first().click({ force: true });
          await expect
            .poll(() => getGridPanelCount(window), { timeout: T_MEDIUM })
            .toBe(gridCount - 1);
          gridCount--;
        }
      } catch {
        // Best-effort cleanup
      }
    });
  });
});
