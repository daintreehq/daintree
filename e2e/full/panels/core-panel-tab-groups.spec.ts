import { test, expect } from "@playwright/test";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  waitForTerminalText,
  waitForTerminalTextIgnoringLineBreaks,
  runTerminalCommand,
} from "../../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Panel Tab Groups", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "tab-groups", withMultipleFiles: true });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();

    // Disable two-pane split mode for this suite's isolation. The crash this
    // workaround originally guarded against (issue #10438 — split layout
    // briefly activating during the 1→2 "Duplicate as new tab" transition) is
    // now fixed by the allGroupsAreVirtual predicate guard, and the dedicated
    // regression block below exercises the fix with split mode left enabled.
    // We keep split mode disabled here so the suite's many duplicate/tab
    // assertions don't have to account for the split layout. Seeding
    // localStorage before the zustand store hydrates avoids it.
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

    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Tab Groups Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // ── Tab Group Lifecycle ─────────────────────────────────

  test.describe.serial("Tab Group Lifecycle", () => {
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
      await runTerminalCommand(window, panel, "node -e \"console.log('TAB_DUPLICATE_ALIVE')\"");
      await waitForTerminalText(panel, "TAB_DUPLICATE_ALIVE", T_LONG);

      // A duplicate is a new process rooted in the worktree it is filed under (#11854)
      await runTerminalCommand(window, panel, 'node -p "process.cwd()"');
      const dirBasename = path.basename(fixtureDir);
      await waitForTerminalTextIgnoringLineBreaks(panel, dirBasename, T_LONG);
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
    test("overflow menu shows expected actions", async () => {
      const { window } = ctx;
      let panel: ReturnType<typeof getFirstGridPanel>;

      await test.step("Open a fresh terminal and wait for it to settle", async () => {
        await openTerminal(window);
        panel = getFirstGridPanel(window);
        await expect(panel).toBeVisible({ timeout: T_LONG });

        await window.waitForTimeout(T_SETTLE);
      });

      await test.step("Open the panel overflow menu", async () => {
        await panel!.hover();
        const overflowBtn = panel!.locator(SEL.panel.overflowMenu).first();
        await overflowBtn.click();
      });

      await test.step("Verify expected menu items are present and removed item is absent", async () => {
        // Verify expected menu items are visible (scoped to window since Radix portals to body)
        const expectedItems = ["Restart Session", "Rename", "Duplicate", "Lock Input", "Trash"];

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
        // FocusScope keeps focus and its typeahead handler swallows the keys
        // typed by `runTerminalCommand`, so the command never reaches the PTY.
        await window.keyboard.press("Escape");
        await expect(window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
      });
    });

    test("restart confirmation flow works", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await test.step("Run a pre-restart marker command", async () => {
        // Settle after the previous test's menu close so xterm input handlers
        // are wired before we start typing.
        await window.waitForTimeout(T_SETTLE);

        await runTerminalCommand(window, panel, "node -e \"console.log('PRE_RESTART')\"");
        await waitForTerminalText(panel, "PRE_RESTART", T_LONG);
      });

      await test.step("Open overflow menu and arm Restart Session", async () => {
        await panel.hover();
        const overflowBtn = panel.locator(SEL.panel.overflowMenu).first();
        await overflowBtn.click();

        const restartBtn = window.locator(SEL.panel.restart).first();
        await expect(restartBtn).toBeVisible({ timeout: T_SHORT });
        await restartBtn.click();
      });

      await test.step("Confirm the restart and verify the panel survives", async () => {
        // Confirm the restart (2-click armed pattern)
        const confirmBtn = window.locator(SEL.panel.restartConfirm).first();
        await expect(confirmBtn).toBeVisible({ timeout: T_SHORT });
        await confirmBtn.click();

        // Panel should remain visible after restart
        await expect(panel).toBeVisible({ timeout: T_LONG });
      });

      await test.step("Verify the new shell accepts a post-restart marker command", async () => {
        await window.waitForTimeout(T_SETTLE);
        await runTerminalCommand(window, panel, "node -e \"console.log('POST_RESTART_OK')\"");
        await waitForTerminalText(panel, "POST_RESTART_OK", T_LONG);
      });
    });

    test.afterAll(async () => {
      // Best-effort cleanup: close all remaining panels
      const { window } = ctx;
      try {
        let count = await getGridPanelCount(window);
        while (count > 0) {
          const panel = getFirstGridPanel(window);
          await panel.locator(SEL.panel.close).first().click({ force: true });
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
          count--;
        }
      } catch {
        // Best-effort cleanup
      }
    });
  });
});

// Regression for issue #10438: "Duplicate as new tab" must not crash the app
// when two-pane split mode is enabled (the default). The 1→2 panel transition
// briefly produced two single-panel groups — one explicit, one virtual — which
// satisfied the old useTwoPaneSplitMode predicate and activated the split
// layout against a panel already in an explicit group, crashing the renderer.
// This block leaves split mode at its default (enabled) — no localStorage seed.
test.describe.serial("Split-mode crash regression (issue #10438)", () => {
  let splitCtx: AppContext;
  let splitFixtureDir: string;
  let splitFixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "tab-groups-split",
      withMultipleFiles: true,
    });
    splitFixtureDir = dir;
    splitFixtureCleanup = cleanup;
    splitCtx = await launchApp();
    splitCtx.window = await openAndOnboardProject(
      splitCtx.app,
      splitCtx.window,
      splitFixtureDir,
      "Tab Groups Split Test"
    );
  });

  test.afterAll(async () => {
    if (splitCtx?.app) await closeApp(splitCtx.app);
    splitFixtureCleanup?.();
  });

  // The two-pane split layout container; present only while split mode is
  // active (TwoPaneSplitLayout renders `data-split-mode="true"`).
  const splitLayout = '[data-split-mode="true"]';

  test("split mode activates for two independent panels but duplicate-as-tab does not crash", async () => {
    const { window } = splitCtx;
    const split = window.locator(splitLayout);

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
