import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getGridPanelIds,
  getDockPanelIds,
  getGridPanelCount,
  getDockPanelCount,
  getPanelById,
  getPanelDragHandle,
  openTerminal,
} from "../../helpers/panels";
import { keyboardReorderElement } from "../../helpers/dragDrop";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Panel Drag & Drop", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "drag-drop" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Drag Drop Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // ── Setup: Open 3 terminals ──────────────────────────────

  test("open 3 terminals for drag tests", async () => {
    const { window } = ctx;

    for (let i = 0; i < 3; i++) {
      await openTerminal(window);
      await window.waitForTimeout(T_SETTLE);
    }

    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);
  });

  // ── Grid Reorder ─────────────────────────────────────────

  test("drag first grid panel to third position reorders panels", async () => {
    const { window } = ctx;

    const idsBefore = await getGridPanelIds(window);
    expect(idsBefore).toHaveLength(3);

    let idsAfter = idsBefore;

    const keySequences = [["ArrowRight"], ["ArrowRight", "ArrowRight"]];

    for (const keys of keySequences) {
      const firstPanel = getPanelById(window, idsBefore[0]);
      const dragHandle = getPanelDragHandle(firstPanel);
      await expect(dragHandle).toBeVisible({ timeout: T_SHORT });

      await keyboardReorderElement(window, dragHandle, keys);

      idsAfter = await getGridPanelIds(window);
      if (idsAfter[0] !== idsBefore[0]) {
        break;
      }
    }

    expect(idsAfter).toHaveLength(3);
    // The dragged panel should have moved past its original position
    expect(idsAfter[0]).not.toBe(idsBefore[0]);
    // All original IDs should still be present (just reordered)
    expect([...idsAfter].sort()).toEqual([...idsBefore].sort());
  });

  // ── Grid to Dock ─────────────────────────────────────────

  test("move a grid panel to the dock", async () => {
    const { window } = ctx;

    const gridIdsBefore = await getGridPanelIds(window);
    expect(gridIdsBefore.length).toBeGreaterThanOrEqual(3);

    const panelToDrag = gridIdsBefore[0];
    const panel = getPanelById(window, panelToDrag);
    const moveToDock = panel.locator(SEL.panel.minimize);
    await expect(moveToDock).toBeVisible({ timeout: T_SHORT });
    await moveToDock.click();

    await expect.poll(() => getDockPanelIds(window), { timeout: T_MEDIUM }).toContain(panelToDrag);

    const gridIdsAfter = await getGridPanelIds(window);
    expect(gridIdsAfter).not.toContain(panelToDrag);
  });

  // ── Dock to Grid ─────────────────────────────────────────

  test("restore a dock panel back to the grid via double-click", async () => {
    const { window } = ctx;

    const dockIdsBefore = await getDockPanelIds(window);
    expect(dockIdsBefore.length).toBeGreaterThanOrEqual(1);

    const panelToRestore = dockIdsBefore[0];

    // The dock chip's aria-label documents the canonical restore gesture as
    // double-click ("Click to preview, double-click to move to grid, drag to
    // reorder"). Drag-from-dock is for reordering within the dock, not for
    // crossing back to the grid — the chip's own onDoubleClick handler calls
    // moveTerminalToGrid + closeDockTerminal directly.
    const dockItem = window.locator(`${SEL.dock.container} [role="listitem"]`).first();
    await expect(dockItem).toBeVisible({ timeout: T_SHORT });
    await dockItem.dblclick();
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
        await dock.locator('[role="listitem"]').first().dblclick();
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
