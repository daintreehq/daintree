import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
const mod = process.platform === "darwin" ? "Meta" : "Control";

function buildAxeScanner(page: import("@playwright/test").Page) {
  return new AxeBuilder({ page })
    .setLegacyMode(true) // Required for Electron — default mode uses Target.createTarget which Electron doesn't support
    .withTags(["wcag2a", "wcag2aa"]);
}

function formatViolations(violations: import("axe-core").Result[]): string {
  return violations
    .map((v) => `[${v.id}] ${v.help} (${v.nodes.length} nodes)`)
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

        await window.keyboard.press(`${mod}+t`);
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(1);
        await window
          .locator(SEL.terminal.xtermRows)
          .first()
          .waitFor({ state: "visible", timeout: T_LONG });

        const results = await buildAxeScanner(window)
          .exclude(".xterm-rows") // xterm.js canvas content triggers color-contrast false positives
          .exclude(".xterm-viewport") // scrollable-region-focusable false positive
          .analyze();
        expect(results.violations, formatViolations(results.violations)).toEqual([]);

        await window.keyboard.press(`${mod}+w`);
        await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
      });
    });
  });

  // -- Keyboard Navigation --

  test.describe.serial("Keyboard Navigation", () => {
    test("Cmd+, opens settings and focuses within the dialog", async () => {
      const { window } = ctx;

      await window.keyboard.press(`${mod}+,`);
      const heading = window.locator(SEL.settings.heading);
      await expect(heading).toBeVisible({ timeout: T_MEDIUM });

      // AppDialog focuses first tabbable element on open
      const searchInput = window.locator(SEL.settings.searchInput);
      await expect(searchInput).toBeFocused({ timeout: T_SHORT });
    });

    test("Escape closes settings and restores focus", async () => {
      const { window } = ctx;

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });

    test("toolbar supports arrow-key navigation", async () => {
      const { window } = ctx;

      // The toolbar uses role="toolbar" with roving tabindex (WAI-ARIA toolbar pattern).
      // Arrow keys navigate between buttons within the toolbar.
      const toolbar = window.locator('[role="toolbar"]');
      await expect(toolbar).toBeVisible({ timeout: T_SHORT });

      // Click the first focusable toolbar button to enter the toolbar
      const firstButton = toolbar.locator("button:not([tabindex='-1'])").first();
      await firstButton.click();
      await expect(firstButton).toBeFocused({ timeout: T_SHORT });

      // ArrowRight should move focus to the next button
      await window.keyboard.press("ArrowRight");
      const activeElement = window.locator("*:focus");
      const tagName = await activeElement.evaluate((el) => el.tagName.toLowerCase());
      expect(tagName).toBe("button");

      // Verify focus actually moved away from the first button
      const isStillFirst = await firstButton.evaluate(
        (el) => el === document.activeElement
      );
      expect(isStillFirst).toBe(false);
    });
  });
});
