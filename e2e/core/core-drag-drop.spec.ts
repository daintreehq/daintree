import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import {
  getGridPanelIds,
  getDockPanelIds,
  getGridPanelCount,
  getDockPanelCount,
  getPanelById,
  getPanelDragHandle,
} from "../helpers/panels";
import { dragElementTo } from "../helpers/dragDrop";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Panel Drag & Drop", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "drag-drop" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Drag Drop Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Setup: Open 3 terminals ──────────────────────────────

  test("open 3 terminals for drag tests", async () => {
    const { window } = ctx;

    for (let i = 0; i < 3; i++) {
      await window.locator(SEL.toolbar.openTerminal).click();
      await window.waitForTimeout(T_SETTLE);
    }

    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);
  });

  // ── Grid Reorder ─────────────────────────────────────────

  test("drag first grid panel to third position reorders panels", async () => {
    const { window } = ctx;

    const idsBefore = await getGridPanelIds(window);
    expect(idsBefore).toHaveLength(3);

    const firstPanel = getPanelById(window, idsBefore[0]);
    const thirdPanel = getPanelById(window, idsBefore[2]);

    const dragHandle = getPanelDragHandle(firstPanel);
    await expect(dragHandle).toBeVisible({ timeout: T_SHORT });

    await dragElementTo(window, dragHandle, thirdPanel);
    await window.waitForTimeout(T_SETTLE);

    const idsAfter = await getGridPanelIds(window);
    expect(idsAfter).toHaveLength(3);
    // The first panel should no longer be at index 0
    expect(idsAfter[0]).not.toBe(idsBefore[0]);
    // The dragged panel should be at or near the end
    expect(idsAfter.indexOf(idsBefore[0])).toBeGreaterThan(0);
    // All original IDs should still be present
    expect(idsAfter.sort()).toEqual(idsBefore.sort());
  });

  // ── Grid to Dock ─────────────────────────────────────────

  test("drag a grid panel to the dock", async () => {
    const { window } = ctx;

    const gridIdsBefore = await getGridPanelIds(window);
    expect(gridIdsBefore.length).toBeGreaterThanOrEqual(3);

    const panelToDrag = gridIdsBefore[0];
    const panel = getPanelById(window, panelToDrag);
    const dragHandle = getPanelDragHandle(panel);
    await expect(dragHandle).toBeVisible({ timeout: T_SHORT });

    const dockTarget = window.locator(SEL.dock.container);
    // The dock may not be visible yet (no items docked). If so, we need a
    // fallback target. The dock container is always in the DOM even when empty
    // but may have zero height. Force-scroll it into view first.
    await dockTarget.evaluate((el) => el.scrollIntoView());

    await dragElementTo(window, dragHandle, dockTarget);
    await window.waitForTimeout(T_SETTLE);

    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_MEDIUM })
      .toBe(gridIdsBefore.length - 1);
    const dockIds = await getDockPanelIds(window);
    expect(dockIds).toContain(panelToDrag);
  });

  // ── Dock to Grid ─────────────────────────────────────────

  test("drag a dock panel back to the grid", async () => {
    const { window } = ctx;

    const dockIdsBefore = await getDockPanelIds(window);
    expect(dockIdsBefore.length).toBeGreaterThanOrEqual(1);

    const panelToRestore = dockIdsBefore[0];

    // Dock items have listeners on the entire SortableDockItem wrapper (role="listitem")
    const dockItem = window.locator(`${SEL.dock.container} [role="listitem"]`).first();
    await expect(dockItem).toBeVisible({ timeout: T_SHORT });

    const gridTarget = window.locator("[data-grid-container]");
    await expect(gridTarget).toBeVisible({ timeout: T_SHORT });

    await dragElementTo(window, dockItem, gridTarget);
    await window.waitForTimeout(T_SETTLE);

    await expect
      .poll(() => getGridPanelIds(window), { timeout: T_MEDIUM })
      .toContain(panelToRestore);
    await expect
      .poll(() => getDockPanelCount(window), { timeout: T_MEDIUM })
      .toBe(dockIdsBefore.length - 1);
  });

  // ── Cleanup ──────────────────────────────────────────────

  test.afterAll(async () => {
    const { window } = ctx;
    try {
      // Close all grid panels
      let gridCount = await getGridPanelCount(window);
      while (gridCount > 0) {
        const panel = window.locator(SEL.panel.gridPanel).first();
        await panel.locator(SEL.panel.close).first().click({ force: true });
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_MEDIUM })
          .toBe(gridCount - 1);
        gridCount--;
      }
      // Restore and close any docked panels
      const dock = window.locator(SEL.dock.container);
      let dockCount = await getDockPanelCount(window);
      while (dockCount > 0) {
        await dock.locator("button").first().dblclick();
        await window.waitForTimeout(T_SETTLE);
        const restored = window.locator(SEL.panel.gridPanel).first();
        await restored.locator(SEL.panel.close).first().click({ force: true });
        await expect
          .poll(() => getDockPanelCount(window), { timeout: T_MEDIUM })
          .toBe(dockCount - 1);
        dockCount--;
      }
    } catch {
      // Best-effort cleanup
    }
  });
});
