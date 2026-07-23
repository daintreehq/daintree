import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount, openTerminal } from "../../helpers/panels";
import { expectPaletteFocused } from "../../helpers/focus";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Action Palette, Command Picker & Quick Switcher", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "palettes-test", withMultipleFiles: true });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Palette Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
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

      await test.step("Verify search input is focused on open", async () => {
        await expectPaletteFocused(window, "action", T_SHORT);
      });

      const searchInput = window.locator(SEL.actionPalette.searchInput);
      const options = window.locator(SEL.actionPalette.options);
      let unfilteredCount = 0;

      await test.step("Type broad query and capture unfiltered count", async () => {
        // Empty query shows only recently-used actions; on a fresh project
        // that list is empty. Type a broad query to populate the list, then
        // narrow it.
        await searchInput.fill("panel");
        await window.waitForTimeout(T_SETTLE);
        await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
        unfilteredCount = await options.count();
      });

      await test.step("Narrow query and verify result count drops", async () => {
        await searchInput.fill("toggle sidebar");
        await window.waitForTimeout(T_SETTLE);

        const filteredCount = await options.count();
        expect(filteredCount).toBeGreaterThanOrEqual(1);
        expect(filteredCount).toBeLessThan(unfilteredCount);
      });
    });

    test("arrow key navigation changes selection", async () => {
      const { window } = ctx;
      const searchInput = window.locator(SEL.actionPalette.searchInput);
      const options = window.locator(SEL.actionPalette.options);
      let initialDescendant: string | null = null;

      await test.step("Type broad query to populate at least two results", async () => {
        // A broad query produces multiple results to navigate through
        // (an empty query would only show recently-used, which is empty
        // on a fresh project).
        await searchInput.fill("panel");
        await window.waitForTimeout(T_SETTLE);

        await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
        const count = await options.count();
        expect(count).toBeGreaterThanOrEqual(2);

        initialDescendant = await searchInput.getAttribute("aria-activedescendant");
      });

      await test.step("Press ArrowDown and verify active descendant updates", async () => {
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
    });

    test("closes via Escape", async () => {
      const { window } = ctx;
      const searchInput = window.locator(SEL.actionPalette.searchInput);

      await searchInput.press("Escape");
      await expect(searchInput).toHaveValue("");
      await searchInput.press("Escape");

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
      await window.locator(SEL.toolbar.projectSwitcherTrigger).focus();
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

      await test.step("Type nonsense query and verify zero results", async () => {
        await searchInput.fill("nonexistent-query-xyz");
        await window.waitForTimeout(T_SETTLE);

        const filteredCount = await options.count();
        expect(filteredCount).toBe(0);
      });

      await test.step("Clear query and press Escape to close dialog", async () => {
        await searchInput.fill("");
        await searchInput.press("Escape");

        const dialog = window.locator(SEL.quickSwitcher.dialog);
        await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
        await expect(dialog).toHaveCount(0, { timeout: T_MEDIUM });
      });
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

      const startBtn = window.locator(SEL.agent.startButton);
      const skipped =
        await test.step("Start an agent panel (skip if CLI is unavailable)", async () => {
          // Agent panel requires CLI availability — skip if not present
          if (!(await startBtn.isVisible().catch(() => false))) {
            return true;
          }

          await startBtn.click();
          await window.waitForTimeout(T_SETTLE);
          return false;
        });
      if (skipped) {
        test.info().annotations.push({
          type: "conditional-skip",
          description: "Required element or state not available in this launch",
        });

        test.skip();
        return;
      }

      const openPickerBtn = window.locator(SEL.commandPicker.openButton);
      const pickerMissing =
        await test.step("Wait for command picker open button to appear", async () => {
          // HybridInputBar's command picker button only renders on agent panels
          return !(await openPickerBtn.isVisible({ timeout: T_LONG }).catch(() => false));
        });
      if (pickerMissing) {
        test.info().annotations.push({
          type: "conditional-skip",
          description: "Command picker button not visible in this launch state",
        });

        test.skip();
        return;
      }

      await test.step("Open command picker dialog and verify visibility", async () => {
        await openPickerBtn.click();

        const dialog = window.locator(SEL.commandPicker.dialog);
        await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
        commandPickerAvailable = true;
      });
    });

    test("search filters commands and Escape closes", async () => {
      if (!commandPickerAvailable) {
        test.info().annotations.push({
          type: "conditional-skip",
          description: "Required element or state not available in this launch",
        });

        test.skip();
        return;
      }

      const { window } = ctx;
      const searchInput = window.locator(SEL.commandPicker.searchInput);
      const options = window.locator(SEL.commandPicker.options);
      let unfilteredCount = 0;

      await test.step("Verify command list renders and capture unfiltered count", async () => {
        const list = window.locator(SEL.commandPicker.list);
        await expect(list).toBeVisible({ timeout: T_MEDIUM });

        unfilteredCount = await options.count();
      });

      await test.step("Filter by 'git' and verify result count narrows", async () => {
        await searchInput.fill("git");
        await window.waitForTimeout(T_SETTLE);

        const filteredCount = await options.count();
        expect(filteredCount).toBeGreaterThanOrEqual(1);
        if (unfilteredCount > 1) {
          expect(filteredCount).toBeLessThanOrEqual(unfilteredCount);
        }
      });

      await test.step("Clear query and press Escape to close dialog", async () => {
        await searchInput.fill("");
        await searchInput.press("Escape");

        const dialog = window.locator(SEL.commandPicker.dialog);
        await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
      });
    });
  });
});
