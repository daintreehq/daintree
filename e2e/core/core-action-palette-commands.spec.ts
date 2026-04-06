import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount, openTerminal } from "../helpers/panels";
import { expectPaletteFocused } from "../helpers/focus";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Action Palette, Command Picker & Quick Switcher", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "palettes-test", withMultipleFiles: true });
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Palette Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Action Palette (4 tests) ──────────────────────────────

  test.describe.serial("Action Palette", () => {
    test.afterAll(async () => {
      try {
        await ctx.window.keyboard.press("Escape");
        await ctx.window.waitForTimeout(T_SETTLE);
      } catch {
        // Best-effort cleanup
      }
    });

    test("opens via keyboard shortcut", async () => {
      const { window } = ctx;
      await window.keyboard.press(`${mod}+Shift+P`);

      const dialog = window.locator(SEL.actionPalette.dialog);
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    });

    test("search input is focused and filters results", async () => {
      const { window } = ctx;

      await expectPaletteFocused(window, "action", T_SHORT);

      const searchInput = window.locator(SEL.actionPalette.searchInput);

      // Capture unfiltered count
      const options = window.locator(SEL.actionPalette.options);
      await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
      const unfilteredCount = await options.count();

      // Type a specific query that should narrow results
      await searchInput.fill("toggle sidebar");
      await window.waitForTimeout(T_SETTLE);

      const filteredCount = await options.count();
      expect(filteredCount).toBeGreaterThanOrEqual(1);
      expect(filteredCount).toBeLessThan(unfilteredCount);
    });

    test("arrow key navigation changes selection", async () => {
      const { window } = ctx;

      const searchInput = window.locator(SEL.actionPalette.searchInput);

      // Clear query to ensure multiple results for navigation
      await searchInput.fill("");
      await window.waitForTimeout(T_SETTLE);

      const options = window.locator(SEL.actionPalette.options);
      await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
      const count = await options.count();
      expect(count).toBeGreaterThanOrEqual(2);

      const initialDescendant = await searchInput.getAttribute("aria-activedescendant");

      await searchInput.press("ArrowDown");

      // Poll until the selection changes — the React state update from
      // selectNext may take a render cycle to flush to the DOM.
      await expect
        .poll(() => searchInput.getAttribute("aria-activedescendant"), { timeout: T_MEDIUM })
        .not.toBe(initialDescendant);

      const newDescendant = await searchInput.getAttribute("aria-activedescendant");
      expect(newDescendant).toBeTruthy();
      expect(newDescendant).toMatch(/^action-option-/);
    });

    test("closes via Escape", async () => {
      const { window } = ctx;
      await window.keyboard.press("Escape");

      const dialog = window.locator(SEL.actionPalette.dialog);
      await expect(dialog).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Quick Switcher (4 tests) ──────────────────────────────

  test.describe.serial("Quick Switcher", () => {
    test.afterAll(async () => {
      try {
        await ctx.window.keyboard.press("Escape");
        await ctx.window.waitForTimeout(T_SETTLE);
        // Close any terminal panels opened during tests
        let count = await getGridPanelCount(ctx.window);
        while (count > 0) {
          const panel = ctx.window.locator(SEL.panel.gridPanel).first();
          await panel.locator(SEL.panel.close).first().click({ force: true });
          await expect
            .poll(() => getGridPanelCount(ctx.window), { timeout: T_MEDIUM })
            .toBe(count - 1);
          count--;
        }
      } catch {
        // Best-effort cleanup
      }
    });

    test("open a terminal panel as prerequisite", async () => {
      const { window } = ctx;
      await openTerminal(window);
      const panel = window.locator(SEL.panel.gridPanel).first();
      await expect(panel).toBeVisible({ timeout: T_LONG });
    });

    test("opens via keyboard shortcut", async () => {
      const { window } = ctx;
      await window.keyboard.press(`${mod}+P`);

      const dialog = window.locator(SEL.quickSwitcher.dialog);
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
    });

    test("shows results after onboarding", async () => {
      const { window } = ctx;

      const options = window.locator(SEL.quickSwitcher.options);
      await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });

      const count = await options.count();
      expect(count).toBeGreaterThanOrEqual(1);
    });

    test("search filters results and Escape closes", async () => {
      const { window } = ctx;

      const searchInput = window.locator(SEL.quickSwitcher.searchInput);
      const options = window.locator(SEL.quickSwitcher.options);

      // Type a nonsense query — results should disappear
      await searchInput.fill("nonexistent-query-xyz");
      await window.waitForTimeout(T_SETTLE);

      const filteredCount = await options.count();
      expect(filteredCount).toBe(0);

      // First Escape clears the search query (two-step escape behavior)
      await window.keyboard.press("Escape");
      // Second Escape closes the dialog
      await window.keyboard.press("Escape");

      const dialog = window.locator(SEL.quickSwitcher.dialog);
      await expect(dialog).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Command Picker (2 tests) ──────────────────────────────

  test.describe.serial("Command Picker", () => {
    let commandPickerAvailable = false;

    test.afterAll(async () => {
      try {
        await ctx.window.keyboard.press("Escape");
        await ctx.window.waitForTimeout(T_SETTLE);
        let count = await getGridPanelCount(ctx.window);
        while (count > 0) {
          const panel = ctx.window.locator(SEL.panel.gridPanel).first();
          await panel.locator(SEL.panel.close).first().click({ force: true });
          await expect
            .poll(() => getGridPanelCount(ctx.window), { timeout: T_MEDIUM })
            .toBe(count - 1);
          count--;
        }
      } catch {
        // Best-effort cleanup
      }
    });

    test("opens via button click on agent panel", async () => {
      const { window } = ctx;

      // Agent panel requires CLI availability — skip if not present
      const startBtn = window.locator(SEL.agent.startButton);
      if (!(await startBtn.isVisible().catch(() => false))) {
        test.skip();
        return;
      }

      await startBtn.click();
      await window.waitForTimeout(T_SETTLE);

      // HybridInputBar's command picker button only renders on agent panels
      const openPickerBtn = window.locator(SEL.commandPicker.openButton);
      if (!(await openPickerBtn.isVisible({ timeout: T_LONG }).catch(() => false))) {
        test.skip();
        return;
      }

      await openPickerBtn.click();

      const dialog = window.locator(SEL.commandPicker.dialog);
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      commandPickerAvailable = true;
    });

    test("search filters commands and Escape closes", async () => {
      if (!commandPickerAvailable) {
        test.skip();
        return;
      }

      const { window } = ctx;

      const list = window.locator(SEL.commandPicker.list);
      await expect(list).toBeVisible({ timeout: T_MEDIUM });

      const options = window.locator(SEL.commandPicker.options);
      const unfilteredCount = await options.count();

      const searchInput = window.locator(SEL.commandPicker.searchInput);
      await searchInput.fill("git");
      await window.waitForTimeout(T_SETTLE);

      const filteredCount = await options.count();
      expect(filteredCount).toBeGreaterThanOrEqual(1);
      if (unfilteredCount > 1) {
        expect(filteredCount).toBeLessThanOrEqual(unfilteredCount);
      }

      // First Escape clears the search query (two-step escape behavior)
      await window.keyboard.press("Escape");
      // Second Escape closes the dialog
      await window.keyboard.press("Escape");

      const dialog = window.locator(SEL.commandPicker.dialog);
      await expect(dialog).not.toBeVisible({ timeout: T_SHORT });
    });
  });
});
