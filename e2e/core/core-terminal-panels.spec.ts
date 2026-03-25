import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openProject, dismissTelemetryConsent } from "../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import {
  getFirstGridPanel,
  getGridPanelCount,
  getDockPanelCount,
  openTerminal,
} from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Terminal & Panels", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "terminal-panels", withMultipleFiles: true });
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Project Onboarding (3 tests) ─────────────────────────

  test.describe.serial("Project Onboarding", () => {
    test("open folder via mocked dialog shows onboarding wizard", async () => {
      await openProject(ctx.app, ctx.window, fixtureDir);

      const heading = ctx.window.locator("h2", { hasText: "Set up your project" });
      await expect(heading).toBeVisible({ timeout: T_LONG });
    });

    test("fill project name and finish onboarding", async () => {
      const { window } = ctx;

      const nameInput = window.getByRole("textbox", { name: "Project Name" });
      await nameInput.fill("Terminal Panels Test");

      await window.getByRole("button", { name: "Finish", exact: true }).click();

      const heading = window.locator("h2", { hasText: "Set up your project" });
      await expect(heading).not.toBeVisible({ timeout: T_MEDIUM });

      await dismissTelemetryConsent(window);
    });

    test("worktree dashboard appears with at least one card", async () => {
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
      await runTerminalCommand(window, panel, "node -e \"console.log('CANOPY_E2E_OK')\"");
      await waitForTerminalText(panel, "CANOPY_E2E_OK", T_LONG);
    });

    test("maximize and unmaximize panel", async () => {
      const { window } = ctx;

      const panel = getFirstGridPanel(window);
      const maximizeBtn = panel.locator('[aria-label*="Maximize"]').first();
      await maximizeBtn.click();

      const exitFocus = window.locator('[aria-label*="Exit Focus"]').first();
      await expect(exitFocus).toBeVisible({ timeout: T_SHORT });

      await exitFocus.click();
      await expect(exitFocus).not.toBeVisible({ timeout: T_SHORT });
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

      const dockItem = dock.locator("button").first();
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
    });

    test("rename terminal by editing title", async () => {
      const { window } = ctx;

      const panel = getFirstGridPanel(window);
      const titleBtn = panel.locator('[role="button"][aria-label*="Terminal title"]').first();
      await expect(titleBtn).toBeVisible({ timeout: T_MEDIUM });

      await titleBtn.click();
      await window.keyboard.press("Enter");

      const titleInput = panel.locator("input").first();
      await expect(titleInput).toBeVisible({ timeout: T_SHORT });

      await titleInput.fill("My Custom Terminal");
      await window.keyboard.press("Enter");

      await expect(panel.locator('[role="button"][aria-label*="My Custom Terminal"]')).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("duplicate terminal as new tab", async () => {
      const { window } = ctx;

      const panel = getFirstGridPanel(window);
      const duplicateBtn = panel.locator(SEL.panel.duplicate).first();
      await duplicateBtn.click({ force: true, timeout: T_MEDIUM });

      const tabList = panel.locator(SEL.panel.tabList);
      await expect(tabList).toBeVisible({ timeout: T_MEDIUM });

      const tabs = tabList.locator(SEL.panel.tab);
      await expect(tabs).toHaveCount(2, { timeout: T_MEDIUM });

      const count = await getGridPanelCount(window);
      expect(count).toBe(1);
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
      await closeBtn.click();

      await window.waitForTimeout(T_SETTLE);
      const remaining = await getGridPanelCount(window);
      if (remaining > 0) {
        const panel2 = getFirstGridPanel(window);
        const closeBtn2 = panel2.locator(SEL.panel.close).first();
        await closeBtn2.click();
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
      const dockItem = dock.locator("button").first();
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
          const dockItem = dock.locator("button").first();
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
      const btn = window.getByRole("toolbar").locator(SEL.toolbar.copyContext);
      await expect(btn).toBeVisible({ timeout: T_MEDIUM });
    });

    test("Copy Context button transitions through states", async () => {
      const { window } = ctx;

      const btn = window.getByRole("toolbar").locator(SEL.toolbar.copyContext);
      await btn.click();

      await expect(btn).toBeVisible({ timeout: T_LONG });
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
