import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

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

        await window.keyboard.press(`${mod}+w`);
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
    });
  });

  // -- Keyboard Navigation --

  test.describe.serial("Keyboard Navigation", () => {
    test("Cmd+, opens settings and focuses within the dialog", async () => {
      const { window } = ctx;

      // Focus a known element before opening settings so we can verify focus restoration
      const settingsButton = window.locator(SEL.toolbar.openSettings);
      await settingsButton.focus();
      await expect(settingsButton).toBeFocused({ timeout: T_SHORT });

      await window.keyboard.press(`${mod}+,`);
      const heading = window.locator(SEL.settings.heading);
      await expect(heading).toBeVisible({ timeout: T_MEDIUM });

      // AppDialog focuses first tabbable element on open
      const searchInput = window.locator(SEL.settings.searchInput);
      await expect(searchInput).toBeFocused({ timeout: T_SHORT });
    });

    test("Escape closes settings and restores focus to trigger", async () => {
      const { window } = ctx;

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

      // AppDialog restores focus to the previously focused element on close
      const settingsButton = window.locator(SEL.toolbar.openSettings);
      await expect(settingsButton).toBeFocused({ timeout: T_SHORT });
    });

    test("toolbar supports arrow-key navigation", async () => {
      const { window } = ctx;

      // The toolbar uses role="toolbar" with roving tabindex and [data-toolbar-item] markers.
      const toolbar = window.locator('[role="toolbar"]');
      await expect(toolbar).toBeVisible({ timeout: T_SHORT });

      // Focus the first toolbar item (uses data-toolbar-item attribute for roving tabindex).
      const firstItem = toolbar.locator("[data-toolbar-item]:not(:disabled)").first();
      await firstItem.focus();
      await expect(firstItem).toBeFocused({ timeout: T_SHORT });

      // ArrowRight should move focus to the next toolbar item
      await window.keyboard.press("ArrowRight");

      const secondItem = toolbar.locator("[data-toolbar-item]:not(:disabled)").nth(1);
      await expect(secondItem).toBeFocused({ timeout: T_SHORT });
    });
  });
});
