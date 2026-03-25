import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";
import { ensureWindowFocused } from "../helpers/focus";
import {
  getActiveElementInfo,
  elementKey,
  escapeTerminalFocus,
  hasVisibleFocusIndicator,
} from "../helpers/keyboard-audit";

let ctx: AppContext;
const mod = process.platform === "darwin" ? "Meta" : "Control";

function buildAxeScanner(page: import("@playwright/test").Page) {
  return new AxeBuilder({ page })
    .setLegacyMode(true) // Required for Electron — default mode uses Target.createTarget which Electron doesn't support
    .withTags(["wcag2a", "wcag2aa"])
    .disableRules([
      // aria-command-name: Radix UI renders div[role="button"] without accessible names
      // on internal menu primitives. Third-party issue, not fixable without upstream changes.
      "aria-command-name",
      // color-contrast: Dark theme color ratios are intentional design choices. xterm.js
      // canvas content also triggers false positives. Fires across the entire app, so
      // .exclude() on individual selectors is impractical.
      "color-contrast",
      // aria-required-children: xterm.js terminal grid uses ARIA roles that don't satisfy
      // required-children constraints. Third-party DOM structure, not fixable.
      "aria-required-children",
      // nested-interactive: xterm.js nests interactive elements within its DOM tree.
      // Third-party DOM structure, not fixable.
      "nested-interactive",
    ]);
}

function formatViolations(violations: import("axe-core").Result[]): string {
  return violations
    .map((v) => {
      const targets = v.nodes.map((n) => n.target.join(" > ")).join(", ");
      return `[${v.id}] ${v.help} (${v.impact}) — ${targets}`;
    })
    .join("\n");
}

test.describe.serial("Core: Accessibility", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // -- Axe WCAG 2.0 AA Audits --

  test.describe.serial("Axe Audits", () => {
    test("welcome screen passes WCAG 2.0 AA audit", async () => {
      const { window } = ctx;
      await window.getByRole("button", { name: "Open Folder" }).waitFor({
        state: "visible",
        timeout: T_MEDIUM,
      });

      const results = await buildAxeScanner(window).analyze();
      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });

    test.describe.serial("With Project", () => {
      test.beforeAll(async () => {
        const fixtureDir = createFixtureRepo({ name: "accessibility" });
        await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Accessibility Test");
      });

      test("worktree dashboard passes WCAG 2.0 AA audit", async () => {
        const { window } = ctx;
        await window
          .locator("[data-worktree-branch]")
          .first()
          .waitFor({ state: "visible", timeout: T_LONG });

        const results = await buildAxeScanner(window).analyze();
        expect(results.violations, formatViolations(results.violations)).toEqual([]);
      });

      test("settings dialog passes WCAG 2.0 AA audit", async () => {
        const { window } = ctx;

        await window.locator(SEL.toolbar.openSettings).click();
        await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

        const results = await buildAxeScanner(window).analyze();
        expect(results.violations, formatViolations(results.violations)).toEqual([]);

        await window.keyboard.press("Escape");
        await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
      });

      test("terminal panel passes WCAG 2.0 AA audit", async () => {
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

      test("action palette passes WCAG 2.0 AA audit", async () => {
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

      test("quick switcher passes WCAG 2.0 AA audit", async () => {
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

      // -- Keyboard Navigation --

      test.describe.serial("Keyboard Navigation", () => {
        test("Cmd+, opens settings and focuses within the dialog", async () => {
          const { window } = ctx;

          const settingsButton = window.locator(SEL.toolbar.openSettings);
          await settingsButton.focus();
          await expect(settingsButton).toBeFocused({ timeout: T_SHORT });

          await window.keyboard.press(`${mod}+,`);
          const heading = window.locator(SEL.settings.heading);
          await expect(heading).toBeVisible({ timeout: T_MEDIUM });

          const searchInput = window.locator(SEL.settings.searchInput);
          await expect(searchInput).toBeFocused({ timeout: T_SHORT });
        });

        test("Escape closes settings and restores focus to trigger", async () => {
          const { window } = ctx;

          await window.keyboard.press("Escape");
          await expect(window.locator(SEL.settings.heading)).not.toBeVisible({
            timeout: T_SHORT,
          });

          const settingsButton = window.locator(SEL.toolbar.openSettings);
          await expect(settingsButton).toBeFocused({ timeout: T_SHORT });
        });

        test("toolbar supports arrow-key navigation", async () => {
          const { window } = ctx;

          const toolbar = window.locator('[role="toolbar"]');
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
          const startEl = window.locator(SEL.toolbar.openSettings);
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
            // Small settle for CI stability
            if (i % 20 === 0) await window.waitForTimeout(T_SETTLE / 5);

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
            if (recentKeys.length > 6) recentKeys.shift();

            if (key === lastKey) {
              consecutiveCount++;
              // 4+ consecutive = trap (3 can happen at page boundaries)
              if (consecutiveCount >= 4) {
                traps.push(
                  `Focus trap at Tab #${i}: ${info.tagName} role=${info.role} label="${info.ariaLabel}" text="${info.textContent}"`
                );
                break;
              }
            } else {
              consecutiveCount = 1;
              lastKey = key;
            }

            // Detect 2-element cycle: A-B-A-B-A-B-A-B
            if (recentKeys.length >= 6) {
              const [a, b, c, d, e, f] = recentKeys.slice(-6);
              if (a === c && c === e && b === d && d === f && a !== b) {
                traps.push(`Focus cycle at Tab #${i}: alternating between two elements`);
                break;
              }
            }
          }

          expect(traps, `Unintentional focus traps detected:\n${traps.join("\n")}`).toEqual([]);
          // Sanity check: we visited a reasonable number of unique elements
          expect(visited.size).toBeGreaterThanOrEqual(3);
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
          await expect(window.locator(SEL.settings.searchInput)).toBeFocused({
            timeout: T_SHORT,
          });

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
              timeout: T_SHORT,
            });
          }
        });

        test("focused interactive elements have visible focus indicators", async () => {
          const { window } = ctx;
          await ensureWindowFocused(ctx.app);

          const elementsToTest = [
            { selector: SEL.toolbar.openSettings, name: "Settings button" },
            { selector: SEL.toolbar.openTerminal, name: "Open Terminal button" },
            { selector: SEL.toolbar.toggleSidebar, name: "Toggle Sidebar button" },
          ];

          const failures: string[] = [];

          for (const { selector, name } of elementsToTest) {
            const loc = window.locator(selector);
            if (!(await loc.isVisible())) continue;

            // Verify the element (or its focusable child) has focus-visible
            // styles declared in CSS. We check the class name for Tailwind's
            // focus-visible: prefix rather than runtime computed styles, since
            // programmatic .focus() doesn't trigger :focus-visible in Chromium
            // and Tab navigation in the toolbar uses roving tabindex.
            const hasFocusStyles = await loc.evaluate((el) => {
              const check = (target: Element): boolean => {
                const cn = target.className ?? "";
                if (typeof cn === "string" && cn.includes("focus-visible:")) return true;
                // Also check children (e.g., button inside a wrapper div)
                for (const child of target.children) {
                  if (check(child)) return true;
                }
                return false;
              };
              return check(el);
            });

            if (!hasFocusStyles) {
              failures.push(`${name} (${selector}) has no focus-visible CSS class`);
            }
          }

          expect(failures, `Elements missing focus indicators:\n${failures.join("\n")}`).toEqual(
            []
          );
        });
      });
    });
  });
});
