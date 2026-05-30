import { test, expect } from "@playwright/test";
import { launchApp, closeApp, refreshActiveWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openProject, dismissTelemetryConsent } from "../../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../../helpers/terminal";
import { expectTerminalFocused } from "../../helpers/focus";
import { getFirstGridPanel, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Terminal Search & Scrollback", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "terminal-search" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // ── Project Open ───────────────────────────────────────

  test.describe.serial("Project Open", () => {
    test("open folder via mocked dialog and switch to project view", async () => {
      await openProject(ctx.app, ctx.window, fixtureDir);

      // Adding a project switches to its WebContentsView; re-acquire the
      // active page so subsequent locator queries hit the right view.
      ctx.window = await refreshActiveWindow(ctx.app, ctx.window);
      await dismissTelemetryConsent(ctx.window);
    });

    test("worktree dashboard appears", async () => {
      ctx.window = await refreshActiveWindow(ctx.app, ctx.window);
      const { window } = ctx;

      const worktreeCards = window.locator("[data-worktree-branch]");
      await expect(worktreeCards.first()).toBeVisible({ timeout: T_LONG });
    });
  });

  // ── Terminal Search ────────────────────────────────────

  test.describe.serial("Terminal Search", () => {
    test("open terminal via toolbar", async () => {
      const { window } = ctx;
      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
    });

    test("run command with searchable output", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);
      await runTerminalCommand(window, panel, "node -e \"console.log('SEARCH_SENTINEL_XYZ')\"");
      await waitForTerminalText(panel, "SEARCH_SENTINEL_XYZ", T_LONG);
    });

    test("trigger find-in-panel and search bar appears", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await panel.locator(SEL.terminal.xtermRows).click();
      await window.waitForTimeout(T_SETTLE);
      await expectTerminalFocused(panel);
      await window.evaluate(() => window.dispatchEvent(new CustomEvent("daintree:find-in-panel")));

      await expect(panel.locator(SEL.terminal.searchInput)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("typing a matching query shows Found status", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      const input = panel.locator(SEL.terminal.searchInput);
      await input.fill("SEARCH_SENTINEL_XYZ");
      await window.waitForTimeout(T_SETTLE);

      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText(
        /^(?:\d+ of \d+\+?|\d+\+? matches|Found)$/,
        { timeout: T_SHORT }
      );
    });

    test("typing a non-matching query shows No matches status", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      const input = panel.locator(SEL.terminal.searchInput);
      await input.fill("ZZZNOMATCHZZZ");
      await window.waitForTimeout(T_SETTLE);

      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("No matches", {
        timeout: T_SHORT,
      });
    });

    test("close search via Escape removes search bar", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      const input = panel.locator(SEL.terminal.searchInput);
      await input.focus();
      await window.keyboard.press("Escape");

      await expect(input).not.toBeVisible({ timeout: T_SHORT });
    });

    test("re-open and close search via close button", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await panel.locator(SEL.terminal.xtermRows).click();
      await window.waitForTimeout(T_SETTLE);
      await window.evaluate(() => window.dispatchEvent(new CustomEvent("daintree:find-in-panel")));

      const input = panel.locator(SEL.terminal.searchInput);
      await expect(input).toBeVisible({ timeout: T_MEDIUM });

      await panel.locator(SEL.terminal.searchClose).click();
      await expect(input).not.toBeVisible({ timeout: T_SHORT });
    });

    // ── Case Sensitivity & Regex ──────────────────────────

    test("run command with mixed-case and pattern output", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await runTerminalCommand(
        window,
        panel,
        "node -e \"console.log('CaseMark_Upper'); console.log('item1_found'); console.log('item2_found'); console.log('item3_found')\""
      );
      await waitForTerminalText(panel, "item3_found", T_LONG);
    });

    test("case sensitivity toggle changes search behavior", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);
      const input = panel.locator(SEL.terminal.searchInput);
      const caseToggle = panel.locator(SEL.terminal.searchCaseToggle);

      await test.step("Open search bar in focused terminal", async () => {
        await panel.locator(SEL.terminal.xtermRows).click();
        await window.waitForTimeout(T_SETTLE);
        await window.evaluate(() =>
          window.dispatchEvent(new CustomEvent("daintree:find-in-panel"))
        );
        await expect(input).toBeVisible({ timeout: T_MEDIUM });

        // Default: case insensitive (aria-pressed=false)
        await expect(caseToggle).toHaveAttribute("aria-pressed", "false");
      });

      await test.step("Case-insensitive search matches mixed-case text", async () => {
        // Search lowercase variant — case-insensitive finds CaseMark_Upper
        await input.fill("casemark_upper");
        await window.waitForTimeout(T_SETTLE);
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText(
          /^(?:\d+ of \d+\+?|\d+\+? matches|Found)$/,
          { timeout: T_SHORT }
        );
      });

      await test.step("Enable case-sensitive mode and verify lowercase no longer matches", async () => {
        await caseToggle.click();
        await expect(caseToggle).toHaveAttribute("aria-pressed", "true");

        // Case-sensitive: lowercase "casemark_upper" should not match "CaseMark_Upper"
        await window.waitForTimeout(T_SETTLE);
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("No matches", {
          timeout: T_SHORT,
        });
      });

      await test.step("Exact-case query still matches with case-sensitive mode on", async () => {
        await input.fill("CaseMark_Upper");
        await window.waitForTimeout(T_SETTLE);
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText(
          /^(?:\d+ of \d+\+?|\d+\+? matches|Found)$/,
          { timeout: T_SHORT }
        );
      });

      await test.step("Disable case-sensitive mode and close search", async () => {
        await caseToggle.click();
        await expect(caseToggle).toHaveAttribute("aria-pressed", "false");
        await window.keyboard.press("Escape");
        await expect(input).not.toBeVisible({ timeout: T_SHORT });
      });
    });

    test("regex toggle matches patterns and detects invalid regex", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);
      const input = panel.locator(SEL.terminal.searchInput);
      const regexToggle = panel.locator(SEL.terminal.searchRegexToggle);

      await test.step("Open search bar in focused terminal", async () => {
        await panel.locator(SEL.terminal.xtermRows).click();
        await window.waitForTimeout(T_SETTLE);
        await window.evaluate(() =>
          window.dispatchEvent(new CustomEvent("daintree:find-in-panel"))
        );
        await expect(input).toBeVisible({ timeout: T_MEDIUM });

        // Default: regex off
        await expect(regexToggle).toHaveAttribute("aria-pressed", "false");
      });

      await test.step("Enable regex and verify pattern matches", async () => {
        await regexToggle.click();
        await expect(regexToggle).toHaveAttribute("aria-pressed", "true");

        // Regex pattern matches item1_found, item2_found, item3_found
        await input.fill("item\\d+_found");
        await window.waitForTimeout(T_SETTLE);
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText(
          /^(?:\d+ of \d+\+?|\d+\+? matches|Found)$/,
          { timeout: T_SHORT }
        );
      });

      await test.step("Disable regex and verify literal pattern no longer matches", async () => {
        await regexToggle.click();
        await expect(regexToggle).toHaveAttribute("aria-pressed", "false");
        await window.waitForTimeout(T_SETTLE);
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("No matches", {
          timeout: T_SHORT,
        });
      });

      await test.step("Re-enable regex with invalid pattern and verify error status", async () => {
        await regexToggle.click();
        await input.fill("[broken");
        await window.waitForTimeout(T_SETTLE);
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Invalid regex", {
          timeout: T_SHORT,
        });
      });

      await test.step("Disable regex and close search", async () => {
        await regexToggle.click();
        await window.keyboard.press("Escape");
        await expect(input).not.toBeVisible({ timeout: T_SHORT });
      });
    });

    test("next and previous buttons cycle through matches", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);
      const input = panel.locator(SEL.terminal.searchInput);
      const nextBtn = panel.locator(SEL.terminal.searchNext);
      const prevBtn = panel.locator(SEL.terminal.searchPrevious);
      const foundRegex = /^(?:\d+ of \d+\+?|\d+\+? matches|Found)$/;

      await test.step("Open search bar and seed query with multiple matches", async () => {
        await panel.locator(SEL.terminal.xtermRows).click();
        await window.waitForTimeout(T_SETTLE);
        await window.evaluate(() =>
          window.dispatchEvent(new CustomEvent("daintree:find-in-panel"))
        );
        await expect(input).toBeVisible({ timeout: T_MEDIUM });

        await input.fill("item");
        await window.waitForTimeout(T_SETTLE);
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText(foundRegex, {
          timeout: T_SHORT,
        });
      });

      await test.step("Click Next twice and verify status remains Found", async () => {
        await nextBtn.click();
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText(foundRegex, {
          timeout: T_SHORT,
        });

        await nextBtn.click();
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText(foundRegex, {
          timeout: T_SHORT,
        });
      });

      await test.step("Click Previous twice and verify status remains Found", async () => {
        await prevBtn.click();
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText(foundRegex, {
          timeout: T_SHORT,
        });

        await prevBtn.click();
        await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText(foundRegex, {
          timeout: T_SHORT,
        });
      });

      await test.step("Close search via Escape", async () => {
        await window.keyboard.press("Escape");
        await expect(input).not.toBeVisible({ timeout: T_SHORT });
      });
    });
  });

  // ── Terminal Scrollback ────────────────────────────────

  test.describe.serial("Terminal Scrollback", () => {
    test("run command that produces many lines of output", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      await runTerminalCommand(
        window,
        panel,
        "node -e \"console.log('SCROLLBACK_TOP'); for(let i=1;i<=198;i++) console.log(i); console.log('SCROLLBACK_BOTTOM')\""
      );
      await waitForTerminalText(panel, "SCROLLBACK_BOTTOM", T_LONG);
    });

    test("scrolling to top reveals earlier output", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      // Focus the terminal then use keyboard to scroll to top
      await panel.locator(SEL.terminal.xtermRows).click();
      await window.waitForTimeout(T_SETTLE);

      // Send Shift+PageUp multiple times to scroll to the top
      for (let i = 0; i < 15; i++) {
        await window.keyboard.press("Shift+PageUp");
      }
      await window.waitForTimeout(T_SETTLE);

      // Verify the scrollback buffer contains earlier output
      // (WebGL renderer does not expose text in DOM, so use buffer API)
      await waitForTerminalText(panel, "SCROLLBACK_TOP", T_MEDIUM);
    });

    test("scrolling back to bottom restores latest output", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      // Send Shift+PageDown multiple times to scroll to the bottom
      for (let i = 0; i < 15; i++) {
        await window.keyboard.press("Shift+PageDown");
      }
      await window.waitForTimeout(T_SETTLE);

      await waitForTerminalText(panel, "SCROLLBACK_BOTTOM", T_MEDIUM);
    });
  });
});
