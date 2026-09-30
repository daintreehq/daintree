import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { ensureWindowFocused } from "../../helpers/focus";
import {
  getGridPanelIds,
  getDockPanelIds,
  getDockChipIds,
  getGridPanelCount,
  getDockPanelCount,
  getFirstGridPanel,
  getPanelById,
  getPanelDragHandle,
  openTerminal,
} from "../../helpers/panels";
import { keyboardReorderElement, pointerReorderDockChip } from "../../helpers/dragDrop";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

// One launch for the dock: drag and drop, the popover dismissal guard, the
// popover resize handle, and — as the final step — a relaunch on the same
// userData that proves the popover height persisted. Serial because the layout
// carries from test to test and the relaunch verifies what session 1 wrote.

const PERSISTED_HEIGHT = 420;
// Negative checks sample every frame for this long, so a regression that lands
// a moment after the gesture still fails.
const DWELL_MS = T_SETTLE;

async function dispatchAction(page: Page, actionId: string, args?: unknown): Promise<unknown> {
  return page.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => unknown;
        }
      ).__daintreeDispatchAction(id, a),
    [actionId, args] as const
  );
}

async function setDockedPopoverHeight(page: Page, height: number): Promise<void> {
  await page.evaluate(async (h) => {
    const app = (
      window as unknown as {
        electron?: { app?: { setState?: (s: { dockedPopoverHeight: number }) => Promise<void> } };
      }
    ).electron?.app;
    await app?.setState?.({ dockedPopoverHeight: h });
  }, height);
}

async function getDockedPopoverHeight(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const app = (
      window as unknown as {
        electron?: { app?: { getState?: () => Promise<{ dockedPopoverHeight?: number }> } };
      }
    ).electron?.app;
    const state = await app?.getState?.();
    return state?.dockedPopoverHeight ?? null;
  });
}

/**
 * Sample `selector`'s visibility on every animation frame for `ms`. Returns the
 * elapsed ms of the first frame it was hidden, or null if it held throughout.
 */
async function firstHiddenFrameWithin(page: Page, selector: string, ms: number) {
  return page.evaluate(
    ([sel, duration]) =>
      new Promise<number | null>((resolve) => {
        const start = performance.now();
        const tick = () => {
          const el = document.querySelector(sel);
          const rect = el?.getBoundingClientRect();
          const visible =
            !!el && el.checkVisibility({ visibilityProperty: true }) && !!rect && rect.height > 0;
          const elapsed = performance.now() - start;
          if (!visible) return resolve(Math.round(elapsed));
          if (elapsed >= duration) return resolve(null);
          requestAnimationFrame(tick);
        };
        tick();
      }),
    [selector, ms] as const
  );
}

function dockChipFor(page: Page, panelId: string) {
  return page.locator(`${SEL.dock.rail} [data-dock-item-id="${panelId}"] ${SEL.dock.chip}`);
}

async function openDockPopoverFor(page: Page, panelId: string): Promise<void> {
  const portalTarget = page.locator(`[data-dock-portal-target="${panelId}"]`);
  await expect(async () => {
    if (!(await portalTarget.isVisible())) await dockChipFor(page, panelId).click();
    await expect(portalTarget).toBeVisible({ timeout: T_SHORT });
  }).toPass({ timeout: T_MEDIUM });
}

async function closeDockPopover(page: Page): Promise<void> {
  const handle = page.locator(SEL.panel.dockPopoverResizeHandle);
  await expect(async () => {
    if ((await handle.count()) > 0 && (await handle.first().isVisible())) {
      await page.keyboard.press("Escape");
    }
    await expect(handle).toBeHidden({ timeout: T_SHORT });
  }).toPass({ timeout: T_MEDIUM });
}

test.describe.serial("Core: Dock", () => {
  let ctx: AppContext | null = null;
  let userDataDir: string;
  let fixtureCleanup: (() => void) | undefined;

  function app() {
    if (!ctx) throw new Error("app not launched");
    return ctx;
  }

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-dock-"));
    const { dir, cleanup } = createFixtureRepo({ name: "dock-height" });
    fixtureCleanup = cleanup;
    ctx = await launchApp({ userDataDir });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Dock Test");

    for (let i = 0; i < 3; i++) {
      await openTerminal(ctx.window);
      await expect.poll(() => getGridPanelCount(ctx!.window), { timeout: T_LONG }).toBe(i + 1);
    }
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
    fixtureCleanup?.();
  });

  test("the app-state handler rejects out-of-range popover heights", async () => {
    const { window } = app();
    // Validation lives in the handler (300–2000), so the state stays unset
    // until a valid value is written.
    await setDockedPopoverHeight(window, 299);
    await setDockedPopoverHeight(window, 2001);
    expect(await getDockedPopoverHeight(window)).toBeNull();
  });

  test("keyboard reorder moves a grid panel past its neighbour", async () => {
    const { window } = app();

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
    // (single step) until the order actually changes.
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
    expect(idsAfter[0]).not.toBe(idsBefore[0]);
    expect([...idsAfter].sort()).toEqual([...idsBefore].sort());
  });

  test("move a grid panel to the dock", async () => {
    const { window } = app();

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

  test("restore a dock panel back to the grid via double-click", async () => {
    const { window } = app();

    const dockIdsBefore = await getDockPanelIds(window);
    expect(dockIdsBefore.length).toBeGreaterThanOrEqual(1);

    const panelToRestore = dockIdsBefore[0];

    // The dock chip's aria-label documents the canonical restore gesture as
    // double-click ("Click to preview, double-click to move to grid, drag to
    // reorder"); the chip's own onDoubleClick moves it back to the grid.
    const dockItem = window.locator(`${SEL.dock.container} [role="listitem"]`).first();
    await expect(dockItem).toBeVisible({ timeout: T_SHORT });
    await dockItem.dblclick();

    await expect
      .poll(() => getGridPanelIds(window), { timeout: T_MEDIUM })
      .toContain(panelToRestore);
    await expect
      .poll(() => getDockPanelCount(window), { timeout: T_MEDIUM })
      .toBe(dockIdsBefore.length - 1);
  });

  test("reorder dock chips with pointer drag", async () => {
    const { window } = app();

    // Move two grid panels to the dock, leaving one in the grid. Emptying the
    // grid would tear down the project WebContentsView, so one panel stays
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

      // Both panels were docked individually, so each owns a chip. Poll rather
      // than read once — the rail can be a render behind the offscreen
      // containers. This also pins the ungrouped precondition the final
      // assertion depends on.
      await expect.poll(() => getDockChipIds(window), { timeout: T_MEDIUM }).toEqual(dockIdsBefore);

      await pointerReorderDockChip(window, chips.first(), chips.nth(1));

      await expect
        .poll(() => getDockChipIds(window).then((ids) => ids[0]), { timeout: T_MEDIUM })
        .not.toBe(dockIdsBefore[0]);

      const dockIdsAfter = await getDockChipIds(window);
      expect(dockIdsAfter).toHaveLength(2);
      expect([...dockIdsAfter].sort()).toEqual([...dockIdsBefore].sort());

      // The rail must repaint, not just the store (#11873): reordering writes
      // only `panelIds`, which the offscreen containers mirror directly, so
      // the visible order is the assertion that matters.
      await expect.poll(() => getDockChipIds(window), { timeout: T_MEDIUM }).toEqual(dockIdsAfter);
    });
  });

  // Regression pin for #8161 — `dockPopoverGuard.ts` Guard 2 used to match the
  // global Radix-internal `[data-radix-popper-content-wrapper]`, so any
  // unrelated Radix overlay blocked the dock popover from dismissing. The fix
  // scopes it to the project-owned `[data-dock-popover-child]` attribute.
  // Unit tests in `dockPopoverGuard.test.ts` cover the selector logic; this
  // pins the integration with the real Radix Popover `onInteractOutside` flow.
  test("scopes Guard 2 to project-owned data-dock-popover-child, not global Radix internals", async () => {
    const { window, app: electronApp } = app();
    await ensureWindowFocused(electronApp);

    // A fresh terminal to dock; the grid keeps at least one panel so the
    // project view doesn't tear down.
    const gridBefore = await getGridPanelIds(window);
    await openTerminal(window);
    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_LONG })
      .toBe(gridBefore.length + 1);

    const gridIds = await getGridPanelIds(window);
    expect(gridIds.length).toBeGreaterThanOrEqual(2);

    const dockBefore = await getDockPanelCount(window);
    const dockedId = gridIds.find((id) => !gridBefore.includes(id))!;
    await dispatchAction(window, "terminal.moveToDock", { terminalId: dockedId });
    await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(dockBefore + 1);

    await expect(dockChipFor(window, dockedId)).toBeVisible({ timeout: T_MEDIUM });
    const portalTargetSelector = `[data-dock-portal-target="${dockedId}"]`;
    const portalTarget = window.locator(portalTargetSelector);

    await openDockPopoverFor(window, dockedId);
    expect(await firstHiddenFrameWithin(window, portalTargetSelector, DWELL_MS)).toBeNull();

    // Contract 1: a click on an element marked data-dock-popover-child must NOT
    // dismiss the dock popover.
    await window.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.id = "test-dock-popover-child";
      overlay.setAttribute("data-dock-popover-child", "");
      Object.assign(overlay.style, {
        position: "fixed",
        top: "96px",
        right: "48px",
        width: "120px",
        height: "32px",
        background: "rgba(0,128,255,0.4)",
        pointerEvents: "auto",
        zIndex: "99999",
      });
      document.body.appendChild(overlay);
    });
    await expect(window.locator("#test-dock-popover-child")).toBeVisible({ timeout: T_SHORT });
    await window.locator("#test-dock-popover-child").click();
    expect(await firstHiddenFrameWithin(window, portalTargetSelector, DWELL_MS)).toBeNull();
    await expect(portalTarget).toBeVisible({ timeout: T_SHORT });
    await window.evaluate(() => document.getElementById("test-dock-popover-child")?.remove());

    // Contract 2: a click on a bare Radix popper wrapper that is NOT a
    // dock-popover descendant must dismiss the dock popover.
    await window.evaluate(() => {
      const overlay = document.createElement("div");
      overlay.id = "test-radix-popper";
      overlay.setAttribute("data-radix-popper-content-wrapper", "");
      Object.assign(overlay.style, {
        position: "fixed",
        top: "144px",
        right: "48px",
        width: "120px",
        height: "32px",
        background: "rgba(255,128,0,0.4)",
        pointerEvents: "auto",
        zIndex: "99999",
      });
      document.body.appendChild(overlay);
    });
    await expect(window.locator("#test-radix-popper")).toBeVisible({ timeout: T_SHORT });
    await window.locator("#test-radix-popper").click();
    await expect(portalTarget).not.toBeVisible({ timeout: T_MEDIUM });
    await window.evaluate(() => document.getElementById("test-radix-popper")?.remove());
  });

  // Regression pin for #11065 — the maximized-group focus enforcement snapped
  // focus back to the group's active tab whenever `focusedId` sat outside the
  // group, so opening a dock popover while a tab group was maximized closed it
  // again instantly. A maximized group must COEXIST with the dock popover:
  // the popover stays open and the group stays maximized.
  test("keeps the dock popover open while a grid tab group is maximized", async () => {
    const { window, app: electronApp } = app();
    await ensureWindowFocused(electronApp);

    const dockedId = (await getDockPanelIds(window))[0]!;
    expect(dockedId).toBeTruthy();

    const gridPanel = getFirstGridPanel(window);
    await expect(gridPanel).toBeVisible({ timeout: T_MEDIUM });

    await test.step("Make the grid panel a tab group — only group maximize enforces focus", async () => {
      const tabs = gridPanel.locator(SEL.panel.tabList).locator(SEL.panel.tab);
      if ((await tabs.count()) < 2) {
        // The + button is opacity-0 on single panels, so force the click.
        await gridPanel
          .locator(SEL.panel.duplicate)
          .first()
          .click({ force: true, timeout: T_MEDIUM });
      }
      await expect(tabs.first()).toBeVisible({ timeout: T_MEDIUM });
      expect(await tabs.count()).toBeGreaterThanOrEqual(2);
    });

    const restoreBtn = window.locator(SEL.panel.restore).first();

    await test.step("Maximize the tab group", async () => {
      await gridPanel.locator(SEL.panel.maximize).first().click();
      await expect(restoreBtn).toBeVisible({ timeout: T_SHORT });
    });

    const portalTargetSelector = `[data-dock-portal-target="${dockedId}"]`;

    await test.step("Open the dock popover and prove it survives the settle window", async () => {
      await dockChipFor(window, dockedId).click();
      await expect(window.locator(portalTargetSelector)).toBeVisible({ timeout: T_MEDIUM });

      // The pre-fix popover could flash open before enforcement slammed it
      // shut, so a bare toBeVisible() right after the click would pass on the
      // bug. Sampling every frame through the dwell is the real pin.
      expect(await firstHiddenFrameWithin(window, portalTargetSelector, DWELL_MS)).toBeNull();

      // …and the group is still maximized: coexistence, not an exit-maximize.
      await expect(restoreBtn).toBeVisible({ timeout: T_SHORT });
    });

    await test.step("Restore the group so later steps start from a clean layout", async () => {
      await restoreBtn.click();
      await expect(restoreBtn).not.toBeVisible({ timeout: T_SHORT });
      await closeDockPopover(window);
    });
  });

  test("dragging the top-edge handle grows the popover and persists the height", async () => {
    const { window } = app();

    const dockedId = (await getDockPanelIds(window))[0]!;
    expect(dockedId).toBeTruthy();
    await openDockPopoverFor(window, dockedId);

    const handle = window.locator(SEL.panel.dockPopoverResizeHandle);
    await handle.waitFor({ state: "visible", timeout: T_MEDIUM });

    // offsetParent of the absolutely-positioned handle is the popover container,
    // so its height tracks the rendered popover height.
    const heightOf = () =>
      handle.evaluate(
        (el) =>
          ((el as HTMLElement).offsetParent as HTMLElement | null)?.getBoundingClientRect()
            .height ?? 0
      );

    const before = await heightOf();
    expect(before).toBeGreaterThan(0);

    // Drag the handle upward with the real pointer — the dock is at the bottom
    // so up means taller.
    const point = await handle.evaluate((element) => {
      const box = element.getBoundingClientRect();
      for (const yFraction of [0.25, 0.5, 0.75]) {
        for (const xFraction of [0.5, 0.25, 0.75]) {
          const x = box.left + box.width * xFraction;
          const y = box.top + box.height * yFraction;
          const hit = document.elementFromPoint(x, y);
          if (hit === element || element.contains(hit)) return { x, y };
        }
      }
      throw new Error(
        `resize handle is covered by ${document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.outerHTML.slice(0, 300)}`
      );
    });
    const { x, y: startY } = point;
    await window.mouse.move(x, startY);
    await window.mouse.down();
    await expect
      .poll(() => window.evaluate(() => document.body.style.cursor), { timeout: T_MEDIUM })
      .toBe("row-resize");
    await window.mouse.move(x, startY - 120, { steps: 6 });
    await window.mouse.up();

    await expect.poll(heightOf, { timeout: T_MEDIUM }).toBeGreaterThan(before + 40);

    // The committed height is persisted through the app-state IPC pipeline.
    await expect
      .poll(() => getDockedPopoverHeight(window), { timeout: T_MEDIUM })
      .toBeGreaterThan(500);
  });

  test("docked popover height survives an app restart", async () => {
    const { window: w1, app: app1 } = app();

    await setDockedPopoverHeight(w1, PERSISTED_HEIGHT);
    await expect
      .poll(() => getDockedPopoverHeight(w1), { timeout: T_MEDIUM })
      .toBe(PERSISTED_HEIGHT);

    const pid1 = app1.process().pid!;
    await closeApp(app1);
    await waitForProcessExit(pid1);
    ctx = null;

    ctx = await launchApp({ userDataDir });
    const { window: w2 } = ctx;

    await expect(w2.locator(SEL.toolbar.projectSwitcherTrigger)).toContainText("dock-height", {
      timeout: T_LONG,
    });

    await expect.poll(() => getDockedPopoverHeight(w2), { timeout: T_LONG }).toBe(PERSISTED_HEIGHT);

    // The rehydrated value is what the popover actually renders at (the
    // default is 500, so this cannot pass on a lost value). The container's
    // box can differ from the model by its border, hence the small tolerance.
    await expect.poll(() => getDockPanelCount(w2), { timeout: T_LONG }).toBeGreaterThan(0);
    const dockedId = (await getDockPanelIds(w2))[0]!;
    await openDockPopoverFor(w2, dockedId);
    const handle = w2.locator(SEL.panel.dockPopoverResizeHandle);
    await handle.waitFor({ state: "visible", timeout: T_MEDIUM });
    await expect(handle).toHaveAttribute("aria-valuenow", String(PERSISTED_HEIGHT));
    await expect
      .poll(
        () =>
          handle.evaluate(
            (el, expected) =>
              Math.abs(
                (((el as HTMLElement).offsetParent as HTMLElement | null)?.getBoundingClientRect()
                  .height ?? 0) - expected
              ),
            PERSISTED_HEIGHT
          ),
        { timeout: T_MEDIUM }
      )
      .toBeLessThanOrEqual(4);
  });
});
