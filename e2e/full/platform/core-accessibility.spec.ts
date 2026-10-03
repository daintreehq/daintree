import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { WebContents, WebPreferences } from "electron";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getGridPanelCount,
  getFirstGridPanel,
  getFocusedPanelId,
  getGridPanelIds,
  openBrowser,
  openSettings,
} from "../../helpers/panels";
import { dispatchAction } from "../../helpers/actions";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { ensureWindowFocused, expectTerminalFocused } from "../../helpers/focus";
import {
  getActiveElementInfo,
  elementKey,
  escapeTerminalFocus,
  hasVisibleFocusIndicator,
} from "../../helpers/keyboard-audit";

// One launch for security, accessibility and focus management: the welcome
// screen first (security invariants and its axe audit, while exactly one
// project view exists), then a project for the axe audits, keyboard
// navigation, focus restoration and palette accessibility.

// Internal WebContents method Electron keeps but leaves out of its typings.
type WebContentsWithPrefs = WebContents & { getLastWebPreferences(): WebPreferences | null };

let ctx: AppContext;
const mod = process.platform === "darwin" ? "Meta" : "Control";
let fixtureCleanup: (() => void) | undefined;

function buildAxeScanner(page: import("@playwright/test").Page) {
  return (
    new AxeBuilder({ page })
      .setLegacyMode(true) // Required for Electron — default mode uses Target.createTarget which Electron doesn't support
      // axe WCAG tags are non-hierarchical; retain 2.0 tags alongside 2.1/2.2 tags.
      // Note: in axe-core 4.11 the only 2.2 AA rule (target-size) is disabled by default
      // and would need .enableRules(["target-size"]) to fire.
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .disableRules([
        // aria-command-name: Radix UI renders div[role="button"] without accessible names
        // on internal menu primitives. Third-party issue, not fixable without upstream changes.
        "aria-command-name",
        // color-contrast: Dark theme color ratios are intentional design choices. xterm.js
        // canvas content also triggers false positives. Fires across the entire app, so
        // .exclude() on individual selectors is impractical.
        "color-contrast",
      ])
  );
}

function formatViolations(violations: import("axe-core").Result[]): string {
  return violations
    .map((v) => {
      const targets = v.nodes.map((n) => n.target.join(" > ")).join(", ");
      return `[${v.id}] ${v.help} (${v.impact}) — ${targets}`;
    })
    .join("\n");
}

async function openQuickSwitcher(window: Page): Promise<void> {
  // Cmd+P is the real binding on macOS. With a terminal focused on Linux and
  // Windows, Ctrl+P is a reserved readline key that reaches the PTY instead, so
  // opening is setup there; the dismiss-and-restore under test is real Escape.
  if (process.platform === "darwin") {
    await window.keyboard.press(`${mod}+P`);
    return;
  }
  const result = await dispatchAction(window, "nav.quickSwitcher");
  expect(result.ok, "nav.quickSwitcher dispatch").toBe(true);
}

/**
 * Open the new-terminal palette via its dedicated event — it has no production
 * keyboard/toolbar trigger (see useAppEventListeners).
 */
async function openNewTerminalPalette(window: Page): Promise<void> {
  await window.evaluate(() =>
    globalThis.window.dispatchEvent(new CustomEvent("daintree:open-new-terminal-palette"))
  );
}

/** Opens the panel palette through its real binding (Cmd/Ctrl+N) from the toolbar. */
async function openPanelPalette(window: Page): Promise<void> {
  const anchor = window.locator(SEL.toolbar.toggleSidebar);
  await anchor.focus();
  await expect(anchor).toBeFocused({ timeout: T_SHORT });
  await window.keyboard.press(`${mod}+N`);
}

/** Light local reset: dismiss any open dialog, then put focus back on the app. */
async function resetToApp(window: Page): Promise<void> {
  const openDialogs = window.locator('[role="dialog"]:visible');
  for (let i = 0; i < 3 && (await openDialogs.count()) > 0; i++) {
    const before = await openDialogs.count();
    await window.keyboard.press("Escape");
    await expect
      .poll(() => openDialogs.count(), { timeout: T_SHORT })
      .toBeLessThan(before)
      .catch(() => undefined);
  }
  await expect(openDialogs).toHaveCount(0, { timeout: T_SHORT });
  await window.locator("main").click({ force: true });
}

async function focusToolbarItem(window: Page, target: Locator): Promise<boolean> {
  const toolbar = window.getByRole("toolbar", { name: "Main toolbar" });
  const items = toolbar.locator("[data-toolbar-item]:not(:disabled)");
  const count = await items.count();
  await items.first().focus();
  for (let i = 0; i < count; i++) {
    const isTarget = await target.evaluate(
      (el) => el === document.activeElement || el.contains(document.activeElement)
    );
    if (isTarget) return true;
    await window.keyboard.press("ArrowRight");
  }
  return false;
}

test.describe("Core: Accessibility and focus", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.describe.serial("Welcome screen", () => {
    test("renderer does not expose require", async () => {
      const t = await ctx.window.evaluate(() => typeof require);
      expect(t).toBe("undefined");
    });

    test("renderer does not expose process", async () => {
      const t = await ctx.window.evaluate(() => typeof process);
      expect(t).toBe("undefined");
    });

    test("main window uses secure webPreferences", async () => {
      // After WebContentsView migration, the test page is the inner
      // WebContentsView, not the BrowserWindow's main webContents. Look it up
      // by URL across all alive webContents to verify *its* preferences.
      const prefs = await ctx.app.evaluate(
        ({ webContents }, { pageUrl }) => {
          const wc = webContents.getAllWebContents().find((c) => c.getURL() === pageUrl) as
            WebContentsWithPrefs | undefined;
          return wc?.getLastWebPreferences() ?? null;
        },
        { pageUrl: ctx.window.url() }
      );
      expect(prefs).not.toBeNull();
      expect(prefs!.contextIsolation).toBe(true);
      expect(prefs!.nodeIntegration).toBe(false);
      expect(prefs!.webSecurity).toBe(true);
    });

    test("document includes a non-empty CSP meta tag", async () => {
      const content = await ctx.window
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute("content");
      expect(content).toMatch(/\b(default-src|script-src)\b/);
    });

    test("welcome screen passes WCAG 2.2 AA audit", async () => {
      const { window } = ctx;
      await window.getByRole("button", { name: "Open project", exact: true }).waitFor({
        state: "visible",
        timeout: T_MEDIUM,
      });

      const results = await buildAxeScanner(window).analyze();
      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });
  });

  test.describe("With a project", () => {
    test.beforeAll(async () => {
      const { dir: fixtureDir, cleanup } = createFixtureRepo({
        name: "accessibility",
        withMultipleFiles: true,
      });
      fixtureCleanup = cleanup;
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Accessibility");
    });

    test.describe.serial("Axe audits", () => {
      test("worktree dashboard passes WCAG 2.2 AA audit", async () => {
        const { window } = ctx;
        await window
          .locator("[data-worktree-branch]")
          .first()
          .waitFor({ state: "visible", timeout: T_LONG });

        const results = await buildAxeScanner(window).analyze();
        expect(results.violations, formatViolations(results.violations)).toEqual([]);
      });

      test("settings dialog passes WCAG 2.2 AA audit", async () => {
        const { window } = ctx;

        await openSettings(window);
        await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

        const results = await buildAxeScanner(window).analyze();
        expect(results.violations, formatViolations(results.violations)).toEqual([]);

        await window.keyboard.press("Escape");
        await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
      });

      test("terminal panel passes WCAG 2.2 AA audit", async () => {
        const { window } = ctx;
        const before = await getGridPanelCount(window);

        await window.keyboard.press(`${mod}+Alt+t`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
        await window
          .locator(SEL.terminal.xtermRows)
          .first()
          .waitFor({ state: "visible", timeout: T_LONG });

        const results = await buildAxeScanner(window)
          .exclude(".xterm-screen") // xterm.js terminal content triggers color-contrast false positives
          .exclude(".xterm-viewport") // scrollable-region-focusable false positive
          .analyze();
        expect(results.violations, formatViolations(results.violations)).toEqual([]);

        // Use the close button instead of Cmd+W to avoid quitting the app
        // when this is the only panel (terminal.close quits on last panel)
        const panel = window.locator(SEL.panel.gridPanel).first();
        await panel.locator(SEL.panel.close).first().click({ force: true });
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before);
      });

      test("action palette passes WCAG 2.2 AA audit", async () => {
        const { window } = ctx;

        await window.keyboard.press(`${mod}+Shift+P`);
        await window
          .locator(SEL.actionPalette.dialog)
          .waitFor({ state: "visible", timeout: T_MEDIUM });
        await window
          .locator(SEL.actionPalette.searchInput)
          .waitFor({ state: "visible", timeout: T_SHORT });

        const results = await buildAxeScanner(window).analyze();
        expect(results.violations, formatViolations(results.violations)).toEqual([]);

        await window.keyboard.press("Escape");
        await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({
          timeout: T_SHORT,
        });
      });

      test("quick switcher passes WCAG 2.2 AA audit", async () => {
        const { window } = ctx;

        await window.keyboard.press(`${mod}+P`);
        await window
          .locator(SEL.quickSwitcher.dialog)
          .waitFor({ state: "visible", timeout: T_MEDIUM });
        await window
          .locator(SEL.quickSwitcher.searchInput)
          .waitFor({ state: "visible", timeout: T_SHORT });

        const results = await buildAxeScanner(window).analyze();
        expect(results.violations, formatViolations(results.violations)).toEqual([]);

        await window.keyboard.press("Escape");
        await expect(window.locator(SEL.quickSwitcher.dialog)).not.toBeVisible({
          timeout: T_SHORT,
        });
      });
    });

    test.describe.serial("Keyboard navigation", () => {
      test("Cmd+, opens settings and focuses within the dialog", async () => {
        const { window } = ctx;

        const focusAnchor = window.locator(SEL.toolbar.toggleSidebar);
        await focusAnchor.focus();
        await expect(focusAnchor).toBeFocused({ timeout: T_SHORT });

        await window.keyboard.press(`${mod}+,`);
        const heading = window.locator(SEL.settings.heading);
        await expect(heading).toBeVisible({ timeout: T_MEDIUM });

        // Focus should be within the dialog (search input or first focusable element)
        const dialog = window.locator('[role="dialog"]');
        const focusedInDialog = dialog.locator(":focus");
        await expect(focusedInDialog).toHaveCount(1, { timeout: T_SHORT });
      });

      test("Escape closes settings and restores focus to trigger", async () => {
        const { window } = ctx;

        await window.keyboard.press("Escape");
        await expect(window.locator(SEL.settings.heading)).not.toBeVisible({
          timeout: T_SHORT,
        });

        const focusAnchor = window.locator(SEL.toolbar.toggleSidebar);
        await expect(focusAnchor).toBeFocused({ timeout: T_SHORT });
      });

      test("toolbar supports arrow-key navigation", async () => {
        const { window } = ctx;

        // The page has multiple `role="toolbar"` elements (main toolbar +
        // per-worktree action toolbars). Scope to the main toolbar.
        const toolbar = window.getByRole("toolbar", { name: "Main toolbar" });
        await expect(toolbar).toBeVisible({ timeout: T_SHORT });

        const firstItem = toolbar.locator("[data-toolbar-item]:not(:disabled)").first();
        await firstItem.focus();
        await expect(firstItem).toBeFocused({ timeout: T_SHORT });

        await window.keyboard.press("ArrowRight");

        const secondItem = toolbar.locator("[data-toolbar-item]:not(:disabled)").nth(1);
        await expect(secondItem).toBeFocused({ timeout: T_SHORT });
      });

      test("Tab-order crawl detects no unintentional focus traps", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);

        // Start from a known toolbar element
        const startEl = window.locator(SEL.toolbar.toggleSidebar);
        await startEl.focus();
        await expect(startEl).toBeFocused({ timeout: T_SHORT });

        const MAX_TABS = 200;
        let consecutiveCount = 0;
        let lastKey = "";
        let recentKeys: string[] = [];
        const visited = new Set<string>();
        const traps: string[] = [];

        for (let i = 0; i < MAX_TABS; i++) {
          await window.keyboard.press("Tab");

          const info = await getActiveElementInfo(window);
          if (!info) continue;

          if (info.isTerminal) {
            await escapeTerminalFocus(window);
            consecutiveCount = 0;
            lastKey = "";
            recentKeys = [];
            continue;
          }

          const key = elementKey(info);
          visited.add(key);

          // Track recent keys to detect both single-element traps and 2-element cycles
          recentKeys.push(key);
          if (recentKeys.length > 10) recentKeys.shift();

          if (key === lastKey) {
            consecutiveCount++;
            // 6+ consecutive = trap (5 can happen at page boundaries on CI)
            if (consecutiveCount >= 6) {
              traps.push(
                `Focus trap at Tab #${i}: ${info.tagName} role=${info.role} label="${info.ariaLabel}" text="${info.textContent}"`
              );
              break;
            }
          } else {
            consecutiveCount = 1;
            lastKey = key;
          }

          // Detect 2-element cycle: A-B-A-B-A-B-A-B-A-B
          if (recentKeys.length >= 10) {
            const tail = recentKeys.slice(-10);
            const [a, b] = tail;
            const isCycle = tail.every((k, idx) => k === (idx % 2 === 0 ? a : b));
            if (isCycle && a !== b) {
              traps.push(`Focus cycle at Tab #${i}: alternating between two elements`);
              break;
            }
          }
        }

        expect(traps, `Unintentional focus traps detected:\n${traps.join("\n")}`).toEqual([]);
        // Sanity check: we visited a reasonable number of unique elements
        expect(visited.size).toBeGreaterThanOrEqual(3);
      });

      test("Tab stays terminal input and F6 moves focus out of a focused terminal", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);

        const before = await getGridPanelCount(window);
        await window.keyboard.press(`${mod}+Alt+t`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
        const panel = window.locator(SEL.panel.gridPanel).nth(before);
        await panel.locator(SEL.terminal.xtermRows).waitFor({
          state: "visible",
          timeout: T_LONG,
        });

        // Click into the terminal so xterm's textarea holds focus.
        await panel.locator(SEL.terminal.xtermRows).click();
        await expect
          .poll(async () => (await getActiveElementInfo(window))?.isTerminal ?? false, {
            timeout: T_LONG,
          })
          .toBe(true);

        // Tab is terminal input for shell/agent autocomplete, not a focus
        // escape. Keyboard-only region escape is F6 / Shift+F6.
        await window.keyboard.press("Tab");
        await expect
          .poll(async () => (await getActiveElementInfo(window))?.isTerminal ?? false, {
            timeout: T_LONG,
          })
          .toBe(true);

        await window.keyboard.press("F6");
        await expect
          .poll(async () => (await getActiveElementInfo(window))?.isTerminal ?? false, {
            timeout: T_LONG,
          })
          .toBe(false);

        // Clean up via the close button (Cmd+W quits on the last panel).
        await panel.locator(SEL.panel.close).first().click({ force: true });
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before);
      });

      test("Action Palette traps focus correctly", async () => {
        const { window } = ctx;

        await window.keyboard.press(`${mod}+Shift+P`);
        await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({
          timeout: T_MEDIUM,
        });
        await expect(window.locator(SEL.actionPalette.searchInput)).toBeFocused({
          timeout: T_SHORT,
        });

        try {
          for (let i = 0; i < 5; i++) {
            await window.keyboard.press("Tab");
          }
          const insideAfterTab = await window.evaluate((sel) => {
            const dialog = document.querySelector(sel);
            return dialog?.contains(document.activeElement) ?? false;
          }, SEL.actionPalette.dialog);
          expect(insideAfterTab, "Focus escaped Action Palette after Tab presses").toBe(true);

          for (let i = 0; i < 5; i++) {
            await window.keyboard.press("Shift+Tab");
          }
          const insideAfterShiftTab = await window.evaluate((sel) => {
            const dialog = document.querySelector(sel);
            return dialog?.contains(document.activeElement) ?? false;
          }, SEL.actionPalette.dialog);
          expect(insideAfterShiftTab, "Focus escaped Action Palette after Shift+Tab").toBe(true);
        } finally {
          await window.keyboard.press("Escape");
          await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({
            timeout: T_SHORT,
          });
        }
      });

      test("Quick Switcher traps focus correctly", async () => {
        const { window } = ctx;

        await window.keyboard.press(`${mod}+P`);
        await expect(window.locator(SEL.quickSwitcher.dialog)).toBeVisible({
          timeout: T_MEDIUM,
        });
        await expect(window.locator(SEL.quickSwitcher.searchInput)).toBeFocused({
          timeout: T_SHORT,
        });

        try {
          for (let i = 0; i < 5; i++) {
            await window.keyboard.press("Tab");
          }
          const insideAfterTab = await window.evaluate((sel) => {
            const dialog = document.querySelector(sel);
            return dialog?.contains(document.activeElement) ?? false;
          }, SEL.quickSwitcher.dialog);
          expect(insideAfterTab, "Focus escaped Quick Switcher after Tab presses").toBe(true);

          for (let i = 0; i < 5; i++) {
            await window.keyboard.press("Shift+Tab");
          }
          const insideAfterShiftTab = await window.evaluate((sel) => {
            const dialog = document.querySelector(sel);
            return dialog?.contains(document.activeElement) ?? false;
          }, SEL.quickSwitcher.dialog);
          expect(insideAfterShiftTab, "Focus escaped Quick Switcher after Shift+Tab").toBe(true);
        } finally {
          await window.keyboard.press("Escape");
          await expect(window.locator(SEL.quickSwitcher.dialog)).not.toBeVisible({
            timeout: T_SHORT,
          });
        }
      });

      test("Settings dialog traps focus correctly", async () => {
        const { window } = ctx;

        await window.keyboard.press(`${mod}+,`);
        await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
        // Focus may settle on the search input with a short delay on CI
        const searchInput = window.locator(SEL.settings.searchInput);
        await searchInput.click();
        await expect(searchInput).toBeFocused({ timeout: T_SHORT });

        try {
          for (let i = 0; i < 10; i++) {
            await window.keyboard.press("Tab");
          }
          const insideAfterTab = await window.evaluate(() => {
            const dialog = document.querySelector('[aria-modal="true"]');
            return dialog?.contains(document.activeElement) ?? false;
          });
          expect(insideAfterTab, "Focus escaped Settings dialog after Tab presses").toBe(true);

          for (let i = 0; i < 10; i++) {
            await window.keyboard.press("Shift+Tab");
          }
          const insideAfterShiftTab = await window.evaluate(() => {
            const dialog = document.querySelector('[aria-modal="true"]');
            return dialog?.contains(document.activeElement) ?? false;
          });
          expect(insideAfterShiftTab, "Focus escaped Settings dialog after Shift+Tab").toBe(true);
        } finally {
          await window.keyboard.press("Escape");
          await expect(window.locator(SEL.settings.heading)).not.toBeVisible({
            timeout: T_MEDIUM,
          });
        }
      });

      test("keyboard focus on toolbar buttons draws a visible focus indicator", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);

        // Reached by arrow keys (roving tabindex), so :focus-visible applies the
        // way it does for a keyboard user; programmatic .focus() alone would not.
        const targets = [
          { selector: SEL.toolbar.openSettings, name: "Settings button" },
          { selector: SEL.toolbar.openTerminal, name: "Open terminal button" },
          { selector: SEL.toolbar.toggleSidebar, name: "Toggle sidebar button" },
        ];
        for (const { selector, name } of targets) {
          const target = window.getByRole("toolbar", { name: "Main toolbar" }).locator(selector);
          await expect(target, `${name} is in the main toolbar`).toBeVisible({ timeout: T_SHORT });
          expect(await focusToolbarItem(window, target), `${name} reachable by arrow keys`).toBe(
            true
          );
          expect(await hasVisibleFocusIndicator(window), `${name} has no focus indicator`).toBe(
            true
          );
        }
      });
    });

    test.describe.serial("Focus management", () => {
      test("action palette dismiss restores terminal focus", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);

        let panel: ReturnType<typeof getFirstGridPanel>;

        await test.step("Open a terminal and focus it", async () => {
          const before = await getGridPanelCount(window);
          await window.keyboard.press(`${mod}+Alt+t`);
          await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
          await window
            .locator(SEL.terminal.xtermRows)
            .first()
            .waitFor({ state: "visible", timeout: T_LONG });

          panel = getFirstGridPanel(window);
          await panel.locator(SEL.terminal.xtermRows).click();
          await expectTerminalFocused(panel);
        });

        await test.step("Open action palette and verify search input is focused", async () => {
          await window.keyboard.press(`${mod}+Shift+P`);
          await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
          await expect(window.locator(SEL.actionPalette.searchInput)).toBeFocused({
            timeout: T_SHORT,
          });
        });

        await test.step("Dismiss palette and verify terminal focus is restored", async () => {
          await window.keyboard.press("Escape");
          await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({
            timeout: T_MEDIUM,
          });
          await expectTerminalFocused(panel!, T_MEDIUM);
        });
      });

      test("quick switcher dismiss restores terminal focus", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);
        const panel = getFirstGridPanel(window);

        await test.step("Focus terminal panel", async () => {
          await panel.locator(SEL.terminal.xtermRows).click();
          await expectTerminalFocused(panel);
        });

        await test.step("Open quick switcher and verify search input is focused", async () => {
          await openQuickSwitcher(window);
          await expect(window.locator(SEL.quickSwitcher.dialog)).toBeVisible({ timeout: T_MEDIUM });
          await expect(window.locator(SEL.quickSwitcher.searchInput)).toBeFocused({
            timeout: T_SHORT,
          });
        });

        await test.step("Dismiss switcher and verify terminal focus is restored", async () => {
          await window.keyboard.press("Escape");
          await expect(window.locator(SEL.quickSwitcher.dialog)).not.toBeVisible({
            timeout: T_MEDIUM,
          });
          await expectTerminalFocused(panel, T_MEDIUM);
        });
      });

      test("F6 cycles focus between macro regions", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);
        const panel = getFirstGridPanel(window);
        const grid = window.locator('[role="region"]').filter({
          has: window.locator('[data-grid-container="true"]'),
        });
        const sidebar = window.locator('[aria-label="Sidebar"]');

        await test.step("Focus terminal panel as starting region", async () => {
          await panel.locator(SEL.terminal.xtermRows).click();
          await expectTerminalFocused(panel);
        });

        await test.step("First F6: terminal → grid region", async () => {
          // First F6 from terminal: focusedRegion is null → targets "grid" (first visible region)
          await window.keyboard.press("F6");
          // The grid region has aria-label "Panels" across all layout variants
          await expect(grid).toBeFocused({ timeout: T_MEDIUM });
        });

        await test.step("Second F6: grid → sidebar", async () => {
          await window.keyboard.press("F6");
          await expect(sidebar).toBeFocused({ timeout: T_MEDIUM });
        });

        await test.step("Third F6: sidebar → grid (wraps around)", async () => {
          await window.keyboard.press("F6");
          await expect(grid).toBeFocused({ timeout: T_MEDIUM });
        });
      });

      test("clicking panels changes focused panel ID", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);
        let before = 0;

        await test.step("Open a second terminal so two panels are present", async () => {
          before = await getGridPanelCount(window);
          await window.keyboard.press(`${mod}+Alt+t`);
          await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
          await window
            .locator(SEL.panel.gridPanel)
            .last()
            .locator(SEL.terminal.xtermRows)
            .waitFor({ state: "visible", timeout: T_LONG });

          const ids = await getGridPanelIds(window);
          expect(ids.length).toBeGreaterThanOrEqual(2);
        });

        let firstId: string | null = null;
        await test.step("Click first panel and capture focused panel id", async () => {
          const firstPanel = window.locator(SEL.panel.gridPanel).first();
          await firstPanel.locator(SEL.terminal.xtermRows).click();
          await expectTerminalFocused(firstPanel);
          firstId = await getFocusedPanelId(window);
          expect(firstId).toBeTruthy();
        });

        await test.step("Click second panel and verify focused panel id changes", async () => {
          const secondPanel = window.locator(SEL.panel.gridPanel).last();
          await secondPanel.locator(SEL.terminal.xtermRows).click();
          await expectTerminalFocused(secondPanel);
          const secondId = await getFocusedPanelId(window);
          expect(secondId).toBeTruthy();
          expect(secondId).not.toBe(firstId);
        });

        await test.step("Clean up extra panel created during this test", async () => {
          const panelToClose = window.locator(SEL.panel.gridPanel).last();
          await panelToClose.locator(SEL.panel.close).first().click({ force: true });
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before);
        });
      });

      test("Escape pops layered overlays in LIFO order", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);
        let panel = getFirstGridPanel(window);

        await test.step("Focus terminal as the underlying focus target", async () => {
          if (!(await panel.locator(SEL.terminal.xtermRows).isVisible())) {
            const before = await getGridPanelCount(window);
            await window.keyboard.press(`${mod}+Alt+t`);
            await expect
              .poll(() => getGridPanelCount(window), { timeout: T_LONG })
              .toBeGreaterThan(before);
            panel = window
              .locator(SEL.panel.gridPanel)
              .filter({ has: window.locator(SEL.terminal.xtermRows) })
              .last();
            await expect(panel.locator(SEL.terminal.xtermRows)).toBeVisible({ timeout: T_LONG });
          }
          await panel.locator(SEL.terminal.xtermRows).click();
          await expectTerminalFocused(panel);
        });

        await test.step("Open Settings (bottom of stack), then Action Palette (top)", async () => {
          await window.keyboard.press(`${mod}+,`);
          await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

          await window.keyboard.press(`${mod}+Shift+P`);
          await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
        });

        await test.step("First Escape pops palette only — settings remains", async () => {
          await window.keyboard.press("Escape");
          const paletteDialog = window.locator(SEL.actionPalette.dialog);
          await expect(paletteDialog).not.toBeVisible({ timeout: T_MEDIUM });
          await expect(paletteDialog).toHaveCount(0, { timeout: T_MEDIUM });
          await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });
        });

        await test.step("Second Escape closes settings and restores terminal focus", async () => {
          // Focus a dialog control without activating it. The scope heading is now a menu trigger,
          // so clicking it would add another overlay for Escape to dismiss first.
          await window.locator(SEL.settings.closeButton).focus();
          await window.keyboard.press("Escape");
          await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

          // Focus restored to terminal
          await expectTerminalFocused(panel, T_MEDIUM);
        });
      });

      test("Enter from the grid region enters a non-PTY panel", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);

        const grid = window.locator('[role="region"]').filter({
          has: window.locator('[data-grid-container="true"]'),
        });
        let before = 0;
        let browserPanel: ReturnType<typeof getFirstGridPanel>;
        let browserId: string | null = null;

        await test.step("Open a browser panel and make it the focused panel", async () => {
          before = await getGridPanelCount(window);
          await openBrowser(window);
          await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);

          browserPanel = window.locator(SEL.panel.gridPanel).last();
          browserId = await browserPanel.getAttribute("data-panel-id");
          expect(browserId).toBeTruthy();

          // Click the panel's title bar (top-left, clear of the embedded web view)
          // rather than relying on new panels being auto-focused: it pins
          // `focusedId` AND puts document.activeElement inside the panel, so
          // getFocusedPanelId resolves without depending on the multi-panel
          // `.terminal-selected` fallback.
          await browserPanel.click({ force: true, position: { x: 12, y: 8 } });
          await expect.poll(() => getFocusedPanelId(window), { timeout: T_MEDIUM }).toBe(browserId);
        });

        await test.step("F6 lifts focus to the grid macro region", async () => {
          await window.keyboard.press("F6");
          await expect(grid).toBeFocused({ timeout: T_MEDIUM });
        });

        await test.step("Enter moves focus into the browser panel (#11109)", async () => {
          // This Enter used to no-op: the handler only ever reached a live xterm,
          // so every non-PTY kind swallowed the key and focus stayed on the grid.
          await window.keyboard.press("Enter");
          await expect(browserPanel).toBeFocused({ timeout: T_MEDIUM });
          await expect(grid).not.toBeFocused();
        });

        await test.step("Clean up the browser panel", async () => {
          // No force: it skips the actionability and stability wait, so the click
          // lands at stale coordinates while the panel is still settling and misses
          // the close button entirely.
          await browserPanel.locator(SEL.panel.close).first().click();
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before);
        });
      });
    });

    test.describe.serial("Palette accessibility", () => {
      test.afterEach(async () => {
        // Restore any emulated media so later tests start from defaults.
        await ctx.window.emulateMedia({ reducedMotion: "no-preference", forcedColors: "none" });
        await resetToApp(ctx.window);
      });

      test("palette dialog ships co-located polite and assertive live regions", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);

        await openNewTerminalPalette(window);
        const dialog = window.locator(SEL.newTerminalPalette.dialog);
        await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

        // Structural assertion — unaffected by document.ariaNotify, which can bypass
        // the DOM text path entirely on Chromium 146.
        await expect
          .poll(() => dialog.locator('.sr-only[aria-live="polite"]').count(), { timeout: T_MEDIUM })
          .toBeGreaterThanOrEqual(1);
        await expect
          .poll(() => dialog.locator('.sr-only[aria-live="assertive"]').count(), {
            timeout: T_MEDIUM,
          })
          .toBeGreaterThanOrEqual(1);
      });

      test("new terminal palette exposes a result-count live region", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);

        await openNewTerminalPalette(window);
        await expect(window.locator(SEL.newTerminalPalette.dialog)).toBeVisible({
          timeout: T_MEDIUM,
        });

        // The new-terminal palette renders a hardcoded "{N} terminal types" status
        // region (not announcer-driven), so its text is a reliable signal.
        const liveRegion = window.locator(SEL.newTerminalPalette.liveRegion);
        await expect(liveRegion).toContainText(/terminal types/, { timeout: T_MEDIUM });
      });

      test("reduced motion: palette still opens and closes", async () => {
        const { window } = ctx;
        await window.emulateMedia({ reducedMotion: "reduce" });
        await ensureWindowFocused(ctx.app);

        await openPanelPalette(window);
        const dialog = window.locator(SEL.panelPalette.dialog);
        await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
        await expect(window.locator(SEL.panelPalette.options).first()).toBeVisible({
          timeout: T_MEDIUM,
        });

        const searchInput = window.locator(SEL.panelPalette.searchInput);
        await searchInput.focus();
        await expect(searchInput).toBeFocused({ timeout: T_SHORT });
        await searchInput.press("Escape");
        await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
      });

      test("forced colors: palette opens with a non-color selection cue", async () => {
        const { window } = ctx;

        await window.emulateMedia({ forcedColors: "active" });

        await ensureWindowFocused(ctx.app);
        await openPanelPalette(window);
        const dialog = window.locator(SEL.panelPalette.dialog);
        await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

        // Selection must be conveyed by aria-selected (not colour alone) so it
        // survives forced-colors mode.
        const options = window.locator(SEL.panelPalette.options);
        await expect(options.first()).toBeVisible({ timeout: T_MEDIUM });
        await expect(options.first()).toHaveAttribute("aria-selected", "true");

        // The row's raised fill and neutral outline are both discarded here, so the
        // system-colour fallback in `index.css` is the only thing still marking the
        // row. The attribute assertion above cannot see that rule go missing.
        const selectedOutlineWidth = await options
          .first()
          .evaluate((el) => getComputedStyle(el).outlineWidth);
        expect(selectedOutlineWidth).not.toBe("0px");

        const searchInput = window.locator(SEL.panelPalette.searchInput);
        await searchInput.focus();
        await expect(searchInput).toBeFocused({ timeout: T_SHORT });
        await searchInput.press("Escape");
        await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
      });

      test("action palette restores focus to the triggering toolbar button on Escape", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);
        await resetToApp(window);

        const trigger = window.locator(SEL.toolbar.toggleSidebar);
        await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
        await trigger.focus();
        await expect(trigger).toBeFocused({ timeout: T_SHORT });

        await window.keyboard.press(`${mod}+Shift+P`);
        await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
        const actionInput = window.locator(SEL.actionPalette.searchInput);
        await actionInput.focus();
        await expect(actionInput).toBeFocused({ timeout: T_SHORT });

        await actionInput.press("Escape");
        await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({
          timeout: T_MEDIUM,
        });
        await expect(trigger).toBeFocused({ timeout: T_MEDIUM });
      });

      test("theme palette restores focus to the triggering toolbar button on Escape", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);
        await resetToApp(window);

        const trigger = window.locator(SEL.toolbar.toggleSidebar);
        await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
        await trigger.focus();
        await expect(trigger).toBeFocused({ timeout: T_SHORT });

        await window.keyboard.press(`${mod}+K`);
        await window.keyboard.press(`${mod}+T`);
        await expect(window.locator(SEL.themePalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
        await expect(window.locator('[role="tooltip"][data-state="open"]')).toHaveCount(0, {
          timeout: T_MEDIUM,
        });
        const themeInput = window.locator(SEL.themePalette.searchInput);
        await themeInput.focus();
        await expect(themeInput).toBeFocused({ timeout: T_SHORT });

        await themeInput.press("Escape");
        await expect(window.locator(SEL.themePalette.dialog)).not.toBeVisible({
          timeout: T_MEDIUM,
        });
        await expect(trigger).toBeFocused({ timeout: T_MEDIUM });
      });

      test("nested action -> # -> panel palette handoff releases focus on Escape", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);
        await resetToApp(window);

        await test.step("Open the action palette, then hand off to the panel palette via '#'", async () => {
          await window.keyboard.press(`${mod}+Shift+P`);
          const actionInput = window.locator(SEL.actionPalette.searchInput);
          await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });
          await actionInput.press("#");
          await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({
            timeout: T_MEDIUM,
          });
          await expect(window.locator(SEL.panelPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
          await expect(window.locator(SEL.panelPalette.searchInput)).toBeFocused({
            timeout: T_SHORT,
          });
        });

        await test.step("Escape closes the chain and focus is not trapped in a dismissed palette", async () => {
          await window.keyboard.press("Escape");
          await expect(window.locator(SEL.panelPalette.dialog)).not.toBeVisible({
            timeout: T_MEDIUM,
          });
          await expect(window.locator(SEL.actionPalette.dialog)).toHaveCount(0, {
            timeout: T_MEDIUM,
          });

          // Focus must leave the palette overlay — it must not remain inside any
          // (now-dismissed) dialog. The exact landing element after a palette-to-
          // palette handoff is an implementation detail; the contract under test is
          // that focus is released, not trapped.
          const focusInDialog = await window.evaluate(() =>
            Boolean(document.activeElement?.closest('[role="dialog"]'))
          );
          expect(focusInDialog).toBe(false);
        });
      });

      test("action palette MRU rail surfaces a recently used action after execution", async () => {
        const { window } = ctx;
        await ensureWindowFocused(ctx.app);
        await resetToApp(window);

        await test.step("Execute a benign action to populate the MRU", async () => {
          await window.keyboard.press(`${mod}+Shift+P`);
          const actionInput = window.locator(SEL.actionPalette.searchInput);
          await expect(actionInput).toBeFocused({ timeout: T_MEDIUM });
          await actionInput.fill("Toggle sidebar");
          const options = window.locator(SEL.palettePrefix.actionEnabledOptions);
          await expect(options.first()).toContainText("Toggle sidebar", { timeout: T_MEDIUM });
          await actionInput.press("Enter");
          await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({
            timeout: T_MEDIUM,
          });
        });

        await test.step("Reopen with an empty query and verify the Recently used rail", async () => {
          await window.keyboard.press(`${mod}+Shift+P`);
          await expect(window.locator(SEL.actionPalette.dialog)).toBeVisible({ timeout: T_MEDIUM });
          // MRU persists via async IPC, so poll generously for the section to appear.
          await expect(window.locator(SEL.palettePrefix.recentlyUsedHeader)).toBeVisible({
            timeout: T_LONG,
          });
          // The action we just executed must be the one recorded in the rail.
          const recentToggle = window
            .locator(SEL.palettePrefix.actionEnabledOptions)
            .filter({ hasText: "Toggle sidebar" });
          await expect(recentToggle.first()).toBeVisible({ timeout: T_MEDIUM });
        });

        await test.step("Restore the sidebar state via the same action", async () => {
          const actionInput = window.locator(SEL.actionPalette.searchInput);
          await actionInput.fill("Toggle sidebar");
          const options = window.locator(SEL.palettePrefix.actionEnabledOptions);
          await expect(options.first()).toContainText("Toggle sidebar", { timeout: T_MEDIUM });
          await actionInput.press("Enter");
          await expect(window.locator(SEL.actionPalette.dialog)).not.toBeVisible({
            timeout: T_MEDIUM,
          });
        });
      });
    });
  });
});
