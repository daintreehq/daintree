import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getGridPanelIds,
  getDockPanelIds,
  getDockChipIds,
  getGridPanelCount,
  getDockPanelCount,
  getPanelById,
  getPanelDragHandle,
  openTerminal,
} from "../../helpers/panels";
import { keyboardReorderElement, pointerReorderDockChip } from "../../helpers/dragDrop";
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

    // The grid is a 2D rect-sortable, so which arrow key carries the top-left
    // panel past its neighbour depends on the headless column count (3 panels
    // resolve to 1, 2, or 3 columns by viewport width). The keyboard resolver is
    // scoped to the grid container — an arrow step toward an edge with no
    // same-container neighbour is a no-op, not a step onto the dock
    // (sameContainerKeyboardCoordinates, #10713) — so a single hardcoded
    // direction silently does nothing in the wrong layout. Try each direction
    // (single step) until the order actually changes, mirroring the dock-chip
    // test's Right→Left fallback.
    const directions = [["ArrowRight"], ["ArrowDown"], ["ArrowLeft"], ["ArrowUp"]];

    for (const keys of directions) {
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

  // ── Dock Chip Reorder ────────────────────────────────────

  test("reorder dock chips with pointer drag", async () => {
    const { window } = ctx;

    // Move two grid panels to the dock, leaving one in the grid. Emptying the
    // grid would tear down the project WebContentsView (see the fixme'd dock
    // tests in core-terminal-layout-operations.spec.ts), so we keep one panel
    // resident to preserve the active view while the chips reorder.
    await test.step("Move two grid panels to the dock", async () => {
      const gridIds = await getGridPanelIds(window);
      expect(gridIds.length).toBeGreaterThanOrEqual(3);

      for (const id of gridIds.slice(0, 2)) {
        const panel = getPanelById(window, id);
        const moveToDock = panel.locator(SEL.panel.minimize);
        await expect(moveToDock).toBeVisible({ timeout: T_SHORT });
        await moveToDock.click();
        await expect.poll(() => getDockPanelIds(window), { timeout: T_MEDIUM }).toContain(id);
      }

      await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
    });

    await test.step("Pointer-drag the first chip and verify the dock order changes", async () => {
      const dockIdsBefore = await getDockChipIds(window);
      expect(dockIdsBefore).toHaveLength(2);

      const chips = window.locator(`${SEL.dock.rail} ${SEL.dock.chip}`);
      await expect.poll(() => chips.count(), { timeout: T_MEDIUM }).toBeGreaterThanOrEqual(2);

      // Both panels were docked individually, so no tab group formed and each
      // one owns a chip. Poll rather than read once — the rail can be a render
      // behind the offscreen containers the setup above waited on. This also
      // pins the ungrouped precondition the final assertion depends on: a
      // multi-panel group would collapse N panels into one chip.
      await expect.poll(() => getDockChipIds(window), { timeout: T_MEDIUM }).toEqual(dockIdsBefore);

      await pointerReorderDockChip(window, chips.first(), chips.nth(1));
      const dockIdsAfter = await getDockChipIds(window);

      expect(dockIdsAfter).toHaveLength(2);
      // Same panels, different order — the chip moved past its neighbour.
      expect([...dockIdsAfter].sort()).toEqual([...dockIdsBefore].sort());
      expect(dockIdsAfter[0]).not.toBe(dockIdsBefore[0]);

      // The rail must repaint, not just the store. Reordering writes only
      // `panelIds`, which the offscreen containers above mirror directly — they
      // stayed green while every chip snapped back to its pre-drag slot
      // (#11873), so the visible order is the assertion that matters.
      await expect.poll(() => getDockChipIds(window), { timeout: T_MEDIUM }).toEqual(dockIdsAfter);
    });
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
