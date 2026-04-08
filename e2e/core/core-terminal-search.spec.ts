import { test, expect } from "@playwright/test";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openProject, dismissTelemetryConsent } from "../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import { expectTerminalFocused } from "../helpers/focus";
import { getFirstGridPanel, openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Terminal Search & Scrollback", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "terminal-search" });
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Project Onboarding ─────────────────────────────────

  test.describe.serial("Project Onboarding", () => {
    test("open folder via mocked dialog shows onboarding wizard", async () => {
      await openProject(ctx.app, ctx.window, fixtureDir);

      const heading = ctx.window.locator("h2", { hasText: "Set up your project" });
      await expect(heading).toBeVisible({ timeout: T_LONG });
    });

    test("fill project name and finish onboarding", async () => {
      const { window } = ctx;

      const nameInput = window.getByRole("textbox", { name: "Project Name" });
      await nameInput.fill("Terminal Search Test");

      await window.getByRole("button", { name: "Finish", exact: true }).click();

      const heading = window.locator("h2", { hasText: "Set up your project" });
      await expect(heading).not.toBeVisible({ timeout: T_MEDIUM });

      await dismissTelemetryConsent(window);

      // After onboarding, the ProjectViewManager creates a new WebContentsView.
      // Re-acquire the active page so subsequent tests use the correct view.
      ctx.window = await getActiveAppWindow(ctx.app);
    });

    test("worktree dashboard appears", async () => {
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
      await window.evaluate(() => window.dispatchEvent(new CustomEvent("canopy:find-in-panel")));

      await expect(panel.locator(SEL.terminal.searchInput)).toBeVisible({ timeout: T_MEDIUM });
    });

    test("typing a matching query shows Found status", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      const input = panel.locator(SEL.terminal.searchInput);
      await input.fill("SEARCH_SENTINEL_XYZ");
      await window.waitForTimeout(T_SETTLE);

      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Found", {
        timeout: T_SHORT,
      });
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
      await window.evaluate(() => window.dispatchEvent(new CustomEvent("canopy:find-in-panel")));

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

      // Open search
      await panel.locator(SEL.terminal.xtermRows).click();
      await window.waitForTimeout(T_SETTLE);
      await window.evaluate(() => window.dispatchEvent(new CustomEvent("canopy:find-in-panel")));
      const input = panel.locator(SEL.terminal.searchInput);
      await expect(input).toBeVisible({ timeout: T_MEDIUM });

      const caseToggle = panel.locator(SEL.terminal.searchCaseToggle);

      // Default: case insensitive (aria-pressed=false)
      await expect(caseToggle).toHaveAttribute("aria-pressed", "false");

      // Search lowercase variant — case-insensitive finds CaseMark_Upper
      await input.fill("casemark_upper");
      await window.waitForTimeout(T_SETTLE);
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Found", {
        timeout: T_SHORT,
      });

      // Toggle case ON
      await caseToggle.click();
      await expect(caseToggle).toHaveAttribute("aria-pressed", "true");

      // Case-sensitive: lowercase "casemark_upper" should not match "CaseMark_Upper"
      await window.waitForTimeout(T_SETTLE);
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("No matches", {
        timeout: T_SHORT,
      });

      // Exact case match should still work
      await input.fill("CaseMark_Upper");
      await window.waitForTimeout(T_SETTLE);
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Found", {
        timeout: T_SHORT,
      });

      // Toggle case OFF and close
      await caseToggle.click();
      await expect(caseToggle).toHaveAttribute("aria-pressed", "false");
      await window.keyboard.press("Escape");
      await expect(input).not.toBeVisible({ timeout: T_SHORT });
    });

    test("regex toggle matches patterns and detects invalid regex", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      // Open search
      await panel.locator(SEL.terminal.xtermRows).click();
      await window.waitForTimeout(T_SETTLE);
      await window.evaluate(() => window.dispatchEvent(new CustomEvent("canopy:find-in-panel")));
      const input = panel.locator(SEL.terminal.searchInput);
      await expect(input).toBeVisible({ timeout: T_MEDIUM });

      const regexToggle = panel.locator(SEL.terminal.searchRegexToggle);

      // Default: regex off
      await expect(regexToggle).toHaveAttribute("aria-pressed", "false");

      // Enable regex
      await regexToggle.click();
      await expect(regexToggle).toHaveAttribute("aria-pressed", "true");

      // Regex pattern matches item1_found, item2_found, item3_found
      await input.fill("item\\d+_found");
      await window.waitForTimeout(T_SETTLE);
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Found", {
        timeout: T_SHORT,
      });

      // Disable regex — literal "item\d+_found" doesn't exist
      await regexToggle.click();
      await expect(regexToggle).toHaveAttribute("aria-pressed", "false");
      await window.waitForTimeout(T_SETTLE);
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("No matches", {
        timeout: T_SHORT,
      });

      // Re-enable regex for invalid regex test
      await regexToggle.click();
      await input.fill("[broken");
      await window.waitForTimeout(T_SETTLE);
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Invalid regex", {
        timeout: T_SHORT,
      });

      // Clean up: disable regex and close
      await regexToggle.click();
      await window.keyboard.press("Escape");
      await expect(input).not.toBeVisible({ timeout: T_SHORT });
    });

    test("next and previous buttons cycle through matches", async () => {
      const { window } = ctx;
      const panel = getFirstGridPanel(window);

      // Open search
      await panel.locator(SEL.terminal.xtermRows).click();
      await window.waitForTimeout(T_SETTLE);
      await window.evaluate(() => window.dispatchEvent(new CustomEvent("canopy:find-in-panel")));
      const input = panel.locator(SEL.terminal.searchInput);
      await expect(input).toBeVisible({ timeout: T_MEDIUM });

      // Search for a term with multiple matches
      await input.fill("item");
      await window.waitForTimeout(T_SETTLE);
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Found", {
        timeout: T_SHORT,
      });

      // Click Next multiple times — status stays "Found"
      const nextBtn = panel.locator(SEL.terminal.searchNext);
      const prevBtn = panel.locator(SEL.terminal.searchPrevious);

      await nextBtn.click();
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Found", {
        timeout: T_SHORT,
      });

      await nextBtn.click();
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Found", {
        timeout: T_SHORT,
      });

      // Click Previous — status stays "Found"
      await prevBtn.click();
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Found", {
        timeout: T_SHORT,
      });

      await prevBtn.click();
      await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText("Found", {
        timeout: T_SHORT,
      });

      // Close search
      await window.keyboard.press("Escape");
      await expect(input).not.toBeVisible({ timeout: T_SHORT });
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
