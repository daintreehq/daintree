import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openProject, dismissTelemetryConsent } from "../../helpers/project";
import { refreshActiveWindow } from "../../helpers/launch";
import { waitForTerminalText, runTerminalCommand } from "../../helpers/terminal";
import {
  getFirstGridPanel,
  getGridPanelCount,
  getDockPanelCount,
  copyFullContextFromToolbar,
  expectToolbarButtonReachable,
  openTerminal,
} from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Terminal & Panels", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "terminal-panels",
      withMultipleFiles: true,
    }));
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // ── Project Open ─────────────────────────────────────────

  test.describe.serial("Project Open", () => {
    test("open folder via mocked dialog and switch to project view", async () => {
      await openProject(ctx.app, ctx.window, fixtureDir);

      // The project view is its own WebContentsView, so the original
      // ctx.window points at the now-stale welcome view.
      ctx.window = await refreshActiveWindow(ctx.app, ctx.window);
      await dismissTelemetryConsent(ctx.window);
    });

    test("worktree dashboard appears with at least one card", async () => {
      ctx.window = await refreshActiveWindow(ctx.app, ctx.window);
      const { window } = ctx;

      const worktreeCards = window.locator("[data-worktree-branch]");
      await expect(worktreeCards.first()).toBeVisible({ timeout: T_LONG });

      const count = await worktreeCards.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Terminal Panel Lifecycle (5 tests) ────────────────────

  test.describe.serial("Terminal Panel Lifecycle", () => {
    test("open terminal via toolbar button", async () => {
      const { window } = ctx;
      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
    });

    test("run command and verify output", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);
      await runTerminalCommand(window, panel, "node -e \"console.log('DAINTREE_E2E_OK')\"");
      await waitForTerminalText(panel, "DAINTREE_E2E_OK", T_LONG);
    });

    test("maximize and unmaximize panel", async () => {
      const { window } = ctx;

      const panel = getFirstGridPanel(window);
      const maximizeBtn = panel.locator('[aria-label*="Maximize"]').first();
      await maximizeBtn.click();

      const restoreBtn = window.locator(SEL.panel.restore).first();
      await expect(restoreBtn).toBeVisible({ timeout: T_SHORT });

      await restoreBtn.click();
      await expect(restoreBtn).not.toBeVisible({ timeout: T_SHORT });
    });

    test("minimize to dock and restore", async () => {
      const { window } = ctx;

      const panel = getFirstGridPanel(window);
      // Click the visible "Move to Dock" button on the panel header
      const minimizeBtn = panel.locator(SEL.panel.minimize).first();
      await expect(minimizeBtn).toBeVisible({ timeout: T_SHORT });
      await minimizeBtn.click();

      await expect(panel).not.toBeVisible({ timeout: T_SHORT });
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);

      const dock = window.locator(SEL.dock.container);
      await expect(dock).toBeVisible({ timeout: T_SHORT });

      const dockItem = dock.locator('button[aria-label*="move to grid"]').first();
      await dockItem.dblclick();

      await expect(getFirstGridPanel(window)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("close terminal session", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);
      const closeBtn = panel.locator(SEL.panel.close);
      await closeBtn.click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
    });
  });

  // ── Terminal Operations (5 tests) ─────────────────────────

  test.describe.serial("Terminal Operations", () => {
    test("open terminal via toolbar", async () => {
      const { window } = ctx;
      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
      // Linux CI shard 2/4 of full-terminal has shown a state where two grid
      // panels exist after a single openTerminal click — surfaces the leak
      // here rather than inside the duplicate-tab assertion below.
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
    });

    // Regression: xterm #5893 / #9812. The DOM renderer emits negative inline
    // letter-spacing on emoji spans (OffscreenCanvas mismeasures them); our
    // src/index.css override clamps only those to 0 while sparing positive
    // corrections and spans outside .xterm-rows. Inject probe spans and read the
    // computed cascade synchronously so re-renders can't race the assertion.
    test("clamps negative letter-spacing only inside xterm rows", async () => {
      const { window } = ctx;
      const rows = window.locator(".xterm-rows").first();
      await expect(rows).toBeVisible({ timeout: T_MEDIUM });

      const computed = await rows.evaluate((rowsEl) => {
        const make = (parent: Element, value: string) => {
          const span = document.createElement("span");
          span.style.letterSpacing = value;
          span.textContent = "x";
          parent.appendChild(span);
          const result = getComputedStyle(span).letterSpacing;
          parent.removeChild(span);
          return result;
        };
        return {
          negativeInside: make(rowsEl, "-5.5px"),
          positiveInside: make(rowsEl, "0.5px"),
          negativeOutside: make(document.body, "-5.5px"),
        };
      });

      const normalizeZeroLetterSpacing = (value: string) => (value === "normal" ? "0px" : value);

      // Broken emoji spans get clamped to the container baseline (0).
      expect(normalizeZeroLetterSpacing(computed.negativeInside)).toBe("0px");
      // Legitimate positive corrections (e.g. wide CJK) are untouched.
      expect(computed.positiveInside).toBe("0.5px");
      // The override is scoped to .xterm-rows and leaves the rest of the app alone.
      expect(computed.negativeOutside).toBe("-5.5px");
    });

    test("rename terminal by editing title", async () => {
      const { window } = ctx;

      const panel = getFirstGridPanel(window);
      const titleBtn = panel.locator('[role="button"][aria-label*="Terminal title"]').first();
      await expect(titleBtn).toBeVisible({ timeout: T_MEDIUM });

      try {
        await titleBtn.dblclick({ force: true, timeout: T_SHORT });
      } catch {
        await titleBtn.click({ force: true });
        await window.keyboard.press("Enter");
      }

      const titleInput = panel.locator('input[aria-label="Edit terminal title"]').first();
      await expect(titleInput).toBeVisible({ timeout: T_SHORT });

      await titleInput.fill("My Custom Terminal");
      await window.keyboard.press("Enter");

      await expect(panel.locator('[role="button"][aria-label*="My Custom Terminal"]')).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("duplicate terminal as new tab", async () => {
      const { window } = ctx;

      // Sanity check the precondition before duplicating. If something earlier
      // in the serial block leaked an extra panel, fail here with a clearer
      // signal than the post-duplicate count assertion.
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

      const panel = getFirstGridPanel(window);
      const duplicateBtn = panel.locator(SEL.panel.duplicate).first();
      await duplicateBtn.click({ force: true, timeout: T_MEDIUM });

      const tabList = panel.locator(SEL.panel.tabList);
      await expect(tabList).toBeVisible({ timeout: T_MEDIUM });

      const tabs = tabList.locator(SEL.panel.tab);
      await expect(tabs).toHaveCount(2, { timeout: T_MEDIUM });

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
    });

    test("restart terminal session", async () => {
      const { window } = ctx;

      const panel = getFirstGridPanel(window);
      // Hover to ensure button is interactable, then open overflow menu
      const overflowBtn = panel.locator(SEL.panel.overflowMenu).first();
      await panel.hover();
      await overflowBtn.click();

      // First click on Restart arms confirmation (menu stays open)
      const restartBtn = window.locator(SEL.panel.restart).first();
      await expect(restartBtn).toBeVisible({ timeout: T_SHORT });
      await restartBtn.click();

      // Second click confirms the restart (text changes to "Confirm Restart")
      const confirmBtn = window.locator(SEL.panel.restartConfirm).first();
      await expect(confirmBtn).toBeVisible({ timeout: T_SHORT });
      await confirmBtn.click();

      await expect(panel).toBeVisible({ timeout: T_LONG });
    });

    test("close all tabs leaves empty grid", async () => {
      const { window } = ctx;

      const panel = getFirstGridPanel(window);
      const closeBtn = panel.locator(SEL.panel.close).first();
      await closeBtn.click({ force: true });

      await window.waitForTimeout(T_SETTLE);
      const remaining = await getGridPanelCount(window);
      if (remaining > 0) {
        const panel2 = getFirstGridPanel(window);
        const closeBtn2 = panel2.locator(SEL.panel.close).first();
        await closeBtn2.click({ force: true });
      }

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
    });
  });

  // ── Multi-Panel Grid & Dock (8 tests) ────────────────────

  test.describe.serial("Multi-Panel Grid & Dock", () => {
    test("open 3 terminals via toolbar", async () => {
      const { window } = ctx;

      for (let i = 0; i < 3; i++) {
        await openTerminal(window);
        await window.waitForTimeout(T_SETTLE);
      }

      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);
    });

    test("grid shows 3 panels simultaneously", async () => {
      const { window } = ctx;

      const panels = window.locator(SEL.panel.gridPanel);
      await expect(panels).toHaveCount(3, { timeout: T_MEDIUM });

      for (let i = 0; i < 3; i++) {
        await expect(panels.nth(i)).toBeVisible({ timeout: T_MEDIUM });
      }
    });

    test("minimize first panel to dock", async () => {
      const { window } = ctx;

      const panel = getFirstGridPanel(window);
      const minimizeBtn = panel.locator(SEL.panel.minimize).first();
      await expect(minimizeBtn).toBeVisible({ timeout: T_SHORT });
      await minimizeBtn.click();

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);

      const dock = window.locator(SEL.dock.container);
      await expect(dock).toBeVisible({ timeout: T_SHORT });
    });

    test("minimize second panel to dock", async () => {
      const { window } = ctx;

      const panel = getFirstGridPanel(window);
      const minimizeBtn = panel.locator(SEL.panel.minimize).first();
      await expect(minimizeBtn).toBeVisible({ timeout: T_SHORT });
      await minimizeBtn.click();

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
    });

    test("dock has 2 items, grid has 1", async () => {
      const { window } = ctx;

      const gridCount = await getGridPanelCount(window);
      expect(gridCount).toBe(1);

      const dock = window.locator(SEL.dock.container);
      const dockButtons = dock.locator("button");
      const dockCount = await dockButtons.count();
      expect(dockCount).toBeGreaterThanOrEqual(2);
    });

    test("restore one panel from dock", async () => {
      const { window } = ctx;

      const dock = window.locator(SEL.dock.container);
      const dockItem = dock.locator('button[aria-label*="move to grid"]').first();
      await dockItem.dblclick();

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
    });

    test("close all panels leaves empty grid", async () => {
      const { window } = ctx;

      let count = await getGridPanelCount(window);
      while (count > 0) {
        const panel = getFirstGridPanel(window);
        const closeBtn = panel.locator(SEL.panel.close).first();
        await closeBtn.click({ force: true });
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
        count--;
      }

      expect(await getGridPanelCount(window)).toBe(0);
    });

    test.afterAll(async () => {
      // Restore any remaining docked panels and close them so Context Flow starts clean
      const { window } = ctx;
      try {
        const dock = window.locator(SEL.dock.container);
        let dockCount = await getDockPanelCount(window);
        while (dockCount > 0) {
          const dockItem = dock.locator('button[aria-label*="move to grid"]').first();
          await dockItem.dblclick();
          await expect
            .poll(() => getDockPanelCount(window), { timeout: T_MEDIUM })
            .toBe(dockCount - 1);
          dockCount--;
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
        // Best-effort dock cleanup
      }
    });
  });

  // ── Context Flow (3 tests) ───────────────────────────────

  test.describe.serial("Context Flow", () => {
    test("Copy Context button is visible when project is active", async () => {
      const { window } = ctx;
      await expectToolbarButtonReachable(window, SEL.toolbar.copyContext, T_MEDIUM);
    });

    test("Copy Context button transitions through states", async () => {
      const { app, window } = ctx;

      // Clear first: the next test in this serial block asserts the clipboard
      // is non-empty, which would pass on leftover content from an earlier
      // test even if this copy did nothing. `clear()` rather than
      // `writeText("")` — writing empty text still installs a text format, so
      // the format-count assertion would stay satisfied by the reset itself.
      await app.evaluate(({ clipboard }) => clipboard.clear());
      await expect
        .poll(async () => app.evaluate(({ clipboard }) => clipboard.availableFormats().length), {
          timeout: T_SHORT,
          message: "Clipboard should start empty so the copy below is what the next test sees",
        })
        .toBe(0);

      // The trigger opens a recents panel rather than copying (#11733); the
      // helper follows through to the panel's "Copy full context" row so the
      // serial clipboard assertion below still has a copy to observe.
      await copyFullContextFromToolbar(window, T_MEDIUM);
      await expectToolbarButtonReachable(window, SEL.toolbar.copyContext, T_LONG);
    });

    test("clipboard contains context after copy", async () => {
      const { app } = ctx;

      await expect
        .poll(
          async () => {
            const formats = await app.evaluate(({ clipboard }) => clipboard.availableFormats());
            return formats.length;
          },
          { timeout: T_LONG, message: "Clipboard should have content after copy" }
        )
        .toBeGreaterThan(0);
    });
  });
});
