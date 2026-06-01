import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getGridPanelCount,
  getDockPanelCount,
  getGridPanelIds,
  getDockPanelIds,
  getFirstGridPanel,
  openTerminal,
} from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

interface DispatchResult {
  ok: boolean;
  error?: { code?: string };
}

async function dispatchAction(
  page: Page,
  actionId: string,
  args?: unknown
): Promise<DispatchResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(([id, a]) => (window as any).__daintreeDispatchAction(id, a), [
    actionId,
    args,
  ] as const) as Promise<DispatchResult>;
}

async function closeAllGridPanels(window: Page): Promise<void> {
  let count = await getGridPanelCount(window);
  while (count > 0) {
    const panel = getFirstGridPanel(window);
    await panel.locator(SEL.panel.close).first().click({ force: true });
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
    count--;
  }
}

test.describe.serial("Core: Panel Layout Undo/Redo & Maximize Choreography", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "layout-undo-redo" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();

    // Disable two-pane split before the project loads. The 1→2 panel transition
    // from "Duplicate as new tab" can briefly activate split layout and crash
    // the app (mirrors core-panel-tab-groups.spec.ts).
    await ctx.window.evaluate(() => {
      localStorage.setItem(
        "daintree-two-pane-split",
        JSON.stringify({
          state: {
            config: { enabled: false, defaultRatio: 0.5, preferPreview: false },
            ratioByWorktreeId: {},
          },
          version: 1,
        })
      );
    });

    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Layout Undo Redo");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // ── Undo/Redo across minimize & dock ─────────────────────

  test.describe.serial("Undo/redo across dock moves", () => {
    test("undo and redo a move-to-dock", async () => {
      const { window } = ctx;

      await test.step("Open two terminals", async () => {
        await openTerminal(window);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(1);
        await openTerminal(window);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(2);
      });

      let dockedId = "";

      await test.step("Move a panel to the dock", async () => {
        const gridIds = await getGridPanelIds(window);
        dockedId = gridIds[0]!;
        await dispatchAction(window, "terminal.moveToDock", { terminalId: dockedId });
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
      });

      await test.step("Undo restores the panel to the grid", async () => {
        const res = await dispatchAction(window, "layout.undo");
        expect(res.ok).toBe(true);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
      });

      await test.step("Redo re-applies the move-to-dock", async () => {
        const res = await dispatchAction(window, "layout.redo");
        expect(res.ok).toBe(true);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
      });

      await test.step("Undo back to two grid panels for cleanup", async () => {
        await dispatchAction(window, "layout.undo");
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
        await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
      });
    });

    test("undo history is capped at MAX_UNDO_HISTORY (10)", async () => {
      const { window } = ctx;

      const gridIds = await getGridPanelIds(window);
      expect(gridIds.length).toBeGreaterThanOrEqual(2);
      // Toggle one panel between dock and grid repeatedly. Each move pushes a
      // layout snapshot; the other panel always stays in the grid so the
      // project view is never torn down. 12 mutations (> MAX_UNDO_HISTORY) means
      // the oldest two snapshots are evicted, leaving exactly 10 undoable steps.
      const toggleId = gridIds[1]!;

      await test.step("Perform 12 dock/grid toggles", async () => {
        for (let i = 0; i < 12; i++) {
          const target = i % 2 === 0 ? "terminal.moveToDock" : "terminal.moveToGrid";
          await dispatchAction(window, target, { terminalId: toggleId });
          await window.waitForTimeout(T_SETTLE);
        }
      });

      await test.step("Exactly 10 undos succeed, then undo is disabled", async () => {
        let successfulUndos = 0;
        for (let i = 0; i < 15; i++) {
          const res = await dispatchAction(window, "layout.undo");
          if (!res.ok) {
            expect(res.error?.code).toBe("DISABLED");
            break;
          }
          successfulUndos++;
          await window.waitForTimeout(T_SETTLE);
        }
        expect(successfulUndos).toBe(10);
      });
    });

    test.afterAll(async () => {
      try {
        // Restore any docked panels by id, then close everything for the next group.
        const { window } = ctx;
        for (const id of await getDockPanelIds(window)) {
          await dispatchAction(window, "terminal.moveToGrid", { terminalId: id });
          await window.waitForTimeout(T_SETTLE);
        }
        await closeAllGridPanels(window);
      } catch {
        // Best-effort cleanup
      }
    });
  });

  // ── Maximize interaction with tab groups ─────────────────

  test.describe.serial("Maximize choreography with tab groups", () => {
    test("maximize hides move-to-dock, survives tab switch and tab close", async () => {
      const { window } = ctx;

      await test.step("Create a two-tab group", async () => {
        await openTerminal(window);
        const panel = getFirstGridPanel(window);
        await expect(panel).toBeVisible({ timeout: T_LONG });

        const duplicateBtn = panel.locator(SEL.panel.duplicate).first();
        await duplicateBtn.click({ force: true, timeout: T_MEDIUM });

        const tabs = panel.locator(SEL.panel.tabList).locator(SEL.panel.tab);
        await expect(tabs).toHaveCount(2, { timeout: T_MEDIUM });
      });

      await test.step("Maximize: restore button appears and move-to-dock is gone", async () => {
        const panel = getFirstGridPanel(window);
        await panel.hover();
        await panel.locator(SEL.panel.maximize).first().click();

        await expect(window.locator(SEL.panel.restore).first()).toBeVisible({ timeout: T_SHORT });
        // showMoveToDock is gated on `!isMaximized` — while a panel is maximized
        // no move-to-dock control is rendered anywhere.
        await expect(window.locator(SEL.panel.minimize)).toHaveCount(0, { timeout: T_SHORT });
      });

      await test.step("Switching tabs keeps the panel maximized", async () => {
        // A maximized panel renders outside the grid container, so scope to the
        // window-level tab list rather than the grid panel.
        const tabs = window.locator(SEL.panel.tabList).locator(SEL.panel.tab);

        await tabs.first().click();
        await expect(tabs.first()).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
        await expect(window.locator(SEL.panel.restore).first()).toBeVisible({ timeout: T_SHORT });
      });

      await test.step("Restore returns the group to the grid with both tabs", async () => {
        await window.locator(SEL.panel.restore).first().click();
        await expect(window.locator(SEL.panel.restore)).toHaveCount(0, { timeout: T_SHORT });
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
        // The two-tab group survives the maximize/restore round-trip.
        await expect(window.locator(SEL.panel.tabList).locator(SEL.panel.tab)).toHaveCount(2, {
          timeout: T_MEDIUM,
        });
      });

      await test.step("Closing a tab collapses the group; the panel stays in the grid", async () => {
        const tabs = window.locator(SEL.panel.tabList).locator(SEL.panel.tab);
        await tabs.nth(1).locator('button[aria-label^="Close"]').click({ force: true });

        // Down to one tab — the tab bar collapses but the panel persists in the grid.
        await expect(window.locator(SEL.panel.tabList)).not.toBeVisible({ timeout: T_MEDIUM });
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

        // Move-to-dock is available again now that the panel is a normal grid panel.
        const panel = getFirstGridPanel(window);
        await panel.hover();
        await expect(panel.locator(SEL.panel.minimize)).toBeVisible({ timeout: T_SHORT });
      });
    });

    test.afterAll(async () => {
      try {
        await closeAllGridPanels(ctx.window);
      } catch {
        // Best-effort cleanup
      }
    });
  });
});
