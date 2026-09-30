import { test, expect, type Page } from "@playwright/test";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getTerminalText,
  waitForTerminalText,
  waitForTerminalTextIgnoringLineBreaks,
  runTerminalCommand,
} from "../../helpers/terminal";
import {
  getDockPanelCount,
  getDockPanelIds,
  getFirstGridPanel,
  getGridPanelCount,
  getGridPanelIds,
  openTerminal,
} from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

// The two-pane split layout container; present only while split mode is
// active (ContentGridDefault marks the grid `data-split-mode="true"`).
const SPLIT_LAYOUT = '[data-split-mode="true"]';
const SETTINGS_DIALOG = '[role="dialog"]:has(.settings-sidebar)';

// Layout undo/redo are Cmd+Alt+Z / Cmd+Shift+Alt+Z, where Cmd is Ctrl off macOS.
// KeyZ keeps the physical key, since Option+Z produces "Ω" on macOS.
const PRIMARY = process.platform === "darwin" ? "Meta" : "Control";
const LAYOUT_UNDO_KEYS = `${PRIMARY}+Alt+KeyZ`;
const LAYOUT_REDO_KEYS = `${PRIMARY}+Shift+Alt+KeyZ`;

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

async function closeAllPanels(window: Page): Promise<void> {
  for (const id of await getDockPanelIds(window)) {
    await dispatchAction(window, "terminal.moveToGrid", { terminalId: id });
  }
  await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
  let count = await getGridPanelCount(window);
  while (count > 0) {
    await getFirstGridPanel(window).locator(SEL.panel.close).first().click({ force: true });
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
    count--;
  }
}

// Idempotent so a worker restarted by an earlier failure turns split mode off
// again: the tab-group suites below don't account for the split layout.
async function disableTwoPaneSplit(window: Page): Promise<void> {
  await dispatchAction(window, "app.settings.openTab", { tab: "terminal", subtab: "layout" });
  const dialog = window.locator(SETTINGS_DIALOG);
  await expect(dialog).toBeVisible({ timeout: T_LONG });
  const splitSwitch = dialog.locator('#terminal-two-pane-split [role="switch"]').first();
  await expect(splitSwitch).toBeVisible({ timeout: T_MEDIUM });
  if ((await splitSwitch.getAttribute("aria-checked")) === "true") {
    await splitSwitch.click();
  }
  await expect(splitSwitch).toHaveAttribute("aria-checked", "false", { timeout: T_SHORT });
  await window.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0, { timeout: T_MEDIUM });
}

test.describe("Core: Panel Tab Groups & Layout", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "tab-groups", withMultipleFiles: true });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Tab Groups Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // Regression for issue #10438: "Duplicate as new tab" must not crash the app
  // when two-pane split mode is enabled (the default). The 1→2 panel transition
  // briefly produced two single-panel groups — one explicit, one virtual — which
  // satisfied the old useTwoPaneSplitMode predicate and activated the split
  // layout against a panel already in an explicit group, crashing the renderer.
  // Runs first, while split mode is still at its fresh-profile default.
  test.describe("Split-mode crash regression (issue #10438)", () => {
    test.afterAll(async () => {
      await closeAllPanels(ctx.window);
    });

    test("split mode activates for two independent panels but duplicate-as-tab does not crash", async () => {
      const { window } = ctx;
      const split = window.locator(SPLIT_LAYOUT);

      // Precondition + legitimate-path guard: two independent ungrouped panels
      // (two virtual singleton groups) must activate the split layout. This both
      // proves split mode is genuinely enabled in this context (so the duplicate
      // assertion below isn't vacuously passing with split mode off) and guards
      // the legitimate split path against regression from the new
      // allGroupsAreVirtual predicate term.
      await openTerminal(window);
      await openTerminal(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(2);
      await expect(split).toBeVisible({ timeout: T_MEDIUM });

      // Reduce back to a single panel so the duplicate flow starts from the
      // one-panel state that triggered the crash.
      await window.locator(SEL.panel.gridPanel).last().locator(SEL.panel.close).first().click({
        force: true,
      });
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
      await expect(split).toBeHidden({ timeout: T_MEDIUM });

      // The actual regression: duplicate-as-tab on the solo panel. The old
      // predicate matched the transient explicit+virtual group pair and activated
      // the split layout against an already-grouped panel, crashing the renderer.
      const panel = getFirstGridPanel(window);
      // The + button has opacity-0 on single panels, use force:true
      const duplicateBtn = panel.locator(SEL.panel.duplicate).first();
      await duplicateBtn.click({ force: true, timeout: T_MEDIUM });

      // If the renderer crashed, every locator call below would reject with
      // "Target closed". Reaching a visible tab list with two tabs proves the
      // panel survived and the new panel was folded into the same tab group
      // rather than spilling into the split layout.
      const tabList = panel.locator(SEL.panel.tabList);
      await expect(tabList).toBeVisible({ timeout: T_MEDIUM });

      const tabs = tabList.locator(SEL.panel.tab);
      await expect(tabs).toHaveCount(2, { timeout: T_MEDIUM });

      // The two tabs stay within a single grid panel — a tab group, never the
      // split layout.
      expect(await getGridPanelCount(window)).toBe(1);
      await expect(split).toBeHidden({ timeout: T_SHORT });
    });
  });

  test.describe("With two-pane split off", () => {
    test.beforeAll(async () => {
      await closeAllPanels(ctx.window);
      await disableTwoPaneSplit(ctx.window);
    });

    // ── Tab Group Lifecycle ─────────────────────────────────

    test.describe.serial("Tab Group Lifecycle", () => {
      test.afterAll(async () => {
        await closeAllPanels(ctx.window);
      });

      test("open terminal and run marker command", async () => {
        const { window } = ctx;
        await openTerminal(window);
        const panel = getFirstGridPanel(window);
        await expect(panel).toBeVisible({ timeout: T_LONG });

        // Ensure xterm-screen has non-zero dimensions (regression guard for #4913:
        // Windows blank terminal caused by fit/resize race during transient hidden state)
        const xtermScreen = panel.locator(SEL.terminal.xtermRows);
        await expect(xtermScreen).toBeVisible({ timeout: T_LONG });

        await runTerminalCommand(window, panel, "node -e \"console.log('TAB_ORIGINAL_MARKER')\"");
        await waitForTerminalText(panel, "TAB_ORIGINAL_MARKER", T_LONG);
      });

      test("duplicate creates tab group with 2 tabs", async () => {
        const { window } = ctx;
        const panel = getFirstGridPanel(window);

        // The + button has opacity-0 on single panels, use force:true
        const duplicateBtn = panel.locator(SEL.panel.duplicate).first();
        await duplicateBtn.click({ force: true, timeout: T_MEDIUM });

        const tabList = panel.locator(SEL.panel.tabList);
        await expect(tabList).toBeVisible({ timeout: T_MEDIUM });

        const tabs = tabList.locator(SEL.panel.tab);
        await expect(tabs).toHaveCount(2, { timeout: T_MEDIUM });

        // Still only 1 grid panel (tabs are within the same panel)
        expect(await getGridPanelCount(window)).toBe(1);
      });

      test("duplicated tab launches in its worktree directory and has functional PTY", async () => {
        const { window } = ctx;
        const panel = getFirstGridPanel(window);

        // The duplicated tab should be the active one — verify PTY works
        // Markers are assembled at runtime so the echoed command line can't match.
        await runTerminalCommand(
          window,
          panel,
          "node -e \"console.log('TAB_DUPLICATE_' + 'ALIVE')\""
        );
        await waitForTerminalText(panel, "TAB_DUPLICATE_ALIVE", T_LONG);

        // A duplicate is a new process rooted in the worktree it is filed under (#11854)
        await runTerminalCommand(window, panel, "node -p \"'CWD=' + process.cwd() + '=CWD'\"");
        const dirBasename = path.basename(fixtureDir);
        await waitForTerminalTextIgnoringLineBreaks(panel, `${dirBasename}=CWD`, T_LONG);
      });

      test("clicking tab switches active terminal", async () => {
        const { window } = ctx;
        const panel = getFirstGridPanel(window);
        const tabList = panel.locator(SEL.panel.tabList);
        const tabs = tabList.locator(SEL.panel.tab);

        // Click the first tab (the original terminal)
        await tabs.first().click();
        await expect(tabs.first()).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });

        // The original marker should be visible in this terminal
        await waitForTerminalText(panel, "TAB_ORIGINAL_MARKER", T_LONG);
      });

      test("maximize and restore preserves tab group", async () => {
        const { window } = ctx;
        const panel = getFirstGridPanel(window);

        await test.step("Maximize the panel and verify restore button appears", async () => {
          const maximizeBtn = panel.locator(SEL.panel.maximize).first();
          await maximizeBtn.click();

          const restoreBtn = window.locator(SEL.panel.restore).first();
          await expect(restoreBtn).toBeVisible({ timeout: T_SHORT });
        });

        await test.step("Restore from maximize via restore button", async () => {
          const restoreBtn = window.locator(SEL.panel.restore).first();
          await restoreBtn.click();
          await expect(restoreBtn).not.toBeVisible({ timeout: T_SHORT });
        });

        await test.step("Verify tab list still shows both tabs after restore", async () => {
          const tabList = panel.locator(SEL.panel.tabList);
          await expect(tabList).toBeVisible({ timeout: T_SHORT });
          const tabs = tabList.locator(SEL.panel.tab);
          await expect(tabs).toHaveCount(2, { timeout: T_SHORT });
        });
      });

      test("closing one tab keeps panel open and removes tab bar", async () => {
        const { window } = ctx;
        const panel = getFirstGridPanel(window);
        const tabList = panel.locator(SEL.panel.tabList);
        const tabs = tabList.locator(SEL.panel.tab);

        // Close the second tab (index 1) via its close button
        const secondTab = tabs.nth(1);
        await secondTab.hover();
        const closeBtn = secondTab.locator('button[aria-label^="Close"]');
        await expect(closeBtn).toBeVisible({ timeout: T_SHORT });
        await closeBtn.click();

        // Tab list should disappear (only 1 tab remaining)
        await expect(tabList).not.toBeVisible({ timeout: T_MEDIUM });

        // Panel should still be visible
        await expect(panel).toBeVisible({ timeout: T_SHORT });
        expect(await getGridPanelCount(window)).toBe(1);
      });

      test("closing last panel removes it from grid", async () => {
        const { window } = ctx;
        const panel = getFirstGridPanel(window);
        const closeBtn = panel.locator(SEL.panel.close);
        await closeBtn.click();
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
      });
    });

    // ── Overflow Menu & Restart ─────────────────────────────

    test.describe.serial("Overflow Menu & Restart", () => {
      test.afterAll(async () => {
        await closeAllPanels(ctx.window);
      });

      test("overflow menu shows expected actions", async () => {
        const { window } = ctx;
        let panel: ReturnType<typeof getFirstGridPanel>;

        await test.step("Open a fresh terminal and wait for its screen", async () => {
          await openTerminal(window);
          panel = getFirstGridPanel(window);
          await expect(panel).toBeVisible({ timeout: T_LONG });
          await expect(panel.locator(SEL.terminal.xtermRows)).toBeVisible({ timeout: T_LONG });
        });

        await test.step("Open the panel overflow menu", async () => {
          await panel!.hover();
          const overflowBtn = panel!.locator(SEL.panel.overflowMenu).first();
          await overflowBtn.click();
        });

        await test.step("Verify expected menu items are present and removed item is absent", async () => {
          // Verify expected menu items are visible (scoped to window since Radix portals to body)
          const expectedItems = ["Restart session", "Rename", "Duplicate", "Lock input", "Trash"];

          for (const itemName of expectedItems) {
            await expect(window.getByRole("menuitem", { name: itemName })).toBeVisible({
              timeout: T_SHORT,
            });
          }

          // Removed in #5957 — guard against accidental re-introduction
          await expect(window.getByRole("menuitem", { name: "View Terminal Info" })).toHaveCount(0);
        });

        await test.step("Close the menu and confirm it fully unmounts", async () => {
          // Close the menu and wait for it to fully unmount. Without this assertion
          // the next test races against Radix's close animation: the menu's
          // FocusScope keeps focus and its typeahead handler swallows keys.
          await window.keyboard.press("Escape");
          await expect(window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
        });
      });

      test("restart confirmation flow works", async () => {
        const { window } = ctx;
        const panel = getFirstGridPanel(window);

        // runTerminalCommand waits for the PTY and submits over IPC, so no settle
        // is needed before or after the restart.
        await test.step("Run a pre-restart marker command", async () => {
          await runTerminalCommand(window, panel, "node -e \"console.log('PRE_RESTART')\"");
          await waitForTerminalText(panel, "PRE_RESTART", T_LONG);
        });

        await test.step("Open overflow menu and choose Restart session", async () => {
          await panel.hover();
          const overflowBtn = panel.locator(SEL.panel.overflowMenu).first();
          await overflowBtn.click();

          const restartBtn = window.locator(SEL.panel.restart).first();
          await expect(restartBtn).toBeVisible({ timeout: T_SHORT });
          await restartBtn.click();
        });

        await test.step("Verify the panel survives the restart", async () => {
          // A plain shell restarts on the first click; only a working agent asks.
          await expect(panel).toBeVisible({ timeout: T_LONG });
        });

        await test.step("Wait for the replacement shell to paint its prompt", async () => {
          // A restart replaces the buffer, so the old marker vanishing proves a
          // new PTY took over; input sent before its prompt paints can be lost.
          await expect
            .poll(
              async () => {
                const text = await getTerminalText(panel);
                return !text.includes("PRE_RESTART") && text.trim().length > 0;
              },
              { timeout: T_LONG, message: "restarted shell should replace the old buffer" }
            )
            .toBe(true);
        });

        await test.step("Verify the new shell accepts a post-restart marker command", async () => {
          await runTerminalCommand(window, panel, "node -e \"console.log('POST_RESTART_OK')\"");
          await waitForTerminalText(panel, "POST_RESTART_OK", T_LONG);
        });
      });
    });

    // ── Layout undo/redo across dock moves ──────────────────

    test.describe.serial("Layout undo/redo across dock moves", () => {
      test.beforeAll(async () => {
        const { window } = ctx;
        await openTerminal(window);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(1);
        await openTerminal(window);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(2);
      });

      test.afterAll(async () => {
        await closeAllPanels(ctx.window);
      });

      test("undo and redo a move-to-dock", async () => {
        const { window } = ctx;
        const dockedId = (await getGridPanelIds(window))[0]!;

        await test.step("Move a panel to the dock", async () => {
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

        await test.step("Undo back to two grid panels", async () => {
          await dispatchAction(window, "layout.undo");
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
          await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
        });
      });

      // The 10-entry cap itself is unit-tested (layoutUndoStore.test.ts "caps undo
      // stack at 10 entries"); this proves the real move actions push snapshots and
      // that undo on an exhausted stack is refused.
      test("dock and grid moves each push one snapshot, and undo on an empty stack is disabled", async () => {
        const { window } = ctx;
        const toggleId = (await getGridPanelIds(window))[1]!;

        await test.step("Drain the undo history", async () => {
          let last: DispatchResult = { ok: true };
          for (let i = 0; i < 12 && last.ok; i++) {
            last = await dispatchAction(window, "layout.undo");
          }
          expect(last.ok).toBe(false);
          expect(last.error?.code).toBe("DISABLED");
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
          await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
        });

        await test.step("Move to dock, then back to the grid", async () => {
          await dispatchAction(window, "terminal.moveToDock", { terminalId: toggleId });
          await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
          await dispatchAction(window, "terminal.moveToGrid", { terminalId: toggleId });
          await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
        });

        await test.step("First undo reverts the move-to-grid", async () => {
          expect((await dispatchAction(window, "layout.undo")).ok).toBe(true);
          await expect
            .poll(() => getDockPanelIds(window), { timeout: T_MEDIUM })
            .toEqual([toggleId]);
        });

        await test.step("Second undo reverts the move-to-dock", async () => {
          expect((await dispatchAction(window, "layout.undo")).ok).toBe(true);
          await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
        });

        await test.step("Undo on the now-empty stack is DISABLED", async () => {
          const res = await dispatchAction(window, "layout.undo");
          expect(res.ok).toBe(false);
          expect(res.error?.code).toBe("DISABLED");
        });
      });

      test("the layout undo and redo shortcuts revert and re-apply a move-to-dock", async () => {
        const { window } = ctx;
        const panel = getFirstGridPanel(window);
        const panelId = await panel.getAttribute("data-panel-id");
        expect(panelId).toBeTruthy();

        // The header's move-to-dock button calls the store directly and is not
        // undoable; the panel context menu goes through terminal.moveToDock, which is.
        await test.step("Dock a panel from its context menu", async () => {
          await panel
            .locator("[data-pane-chrome]")
            .first()
            .click({ button: "right", position: { x: 40, y: 10 } });
          await window.getByRole("menuitem", { name: "Move to dock" }).click();
          await expect(window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
          await expect
            .poll(() => getDockPanelIds(window), { timeout: T_MEDIUM })
            .toEqual([panelId]);
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
        });

        await test.step("The undo shortcut returns it to the grid", async () => {
          await window.keyboard.press(LAYOUT_UNDO_KEYS);
          await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
          await expect
            .poll(() => getGridPanelIds(window), { timeout: T_MEDIUM })
            .toContain(panelId);
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
        });

        await test.step("The redo shortcut docks it again", async () => {
          await window.keyboard.press(LAYOUT_REDO_KEYS);
          await expect
            .poll(() => getDockPanelIds(window), { timeout: T_MEDIUM })
            .toEqual([panelId]);
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
        });
      });
    });

    // ── Maximize interaction with tab groups ────────────────

    test.describe("Maximize choreography with tab groups", () => {
      test.beforeAll(async () => {
        await closeAllPanels(ctx.window);
      });

      test.afterAll(async () => {
        await closeAllPanels(ctx.window);
      });

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
          await expect(tabs.first()).toHaveAttribute("aria-selected", "true", {
            timeout: T_SHORT,
          });
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
          const tab = tabs.nth(1);
          await tab.hover();
          const closeBtn = tab.locator('button[aria-label^="Close"]');
          await expect(closeBtn).toBeVisible({ timeout: T_SHORT });
          await closeBtn.click();

          // Down to one tab — the tab bar collapses but the panel persists in the grid.
          await expect(window.locator(SEL.panel.tabList)).not.toBeVisible({ timeout: T_MEDIUM });
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

          // Move-to-dock is available again now that the panel is a normal grid panel.
          const panel = getFirstGridPanel(window);
          await panel.hover();
          await expect(panel.locator(SEL.panel.minimize)).toBeVisible({ timeout: T_SHORT });
        });
      });
    });
  });
});
