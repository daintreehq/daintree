/**
 * Core: v0.3.0 Features
 *
 * Tests for features and UI changes introduced in the v0.3.0 release:
 *
 * - Worktree Sidebar Search (#2748, #2762): persistent inline search bar
 *   with debounced filtering, clear button, and empty state.
 *
 * - Settings Navigation (#2719, #2724): new settings tabs (Notifications,
 *   Worktree Paths, Toolbar, Editor, Image Viewer, MCP Server, Voice Input)
 *   and CLI Agents subtab support (General + per-agent subtabs).
 *
 * - Settings Search (#2719): search input in settings dialog that shows
 *   filtered results and can be cleared to return to normal navigation.
 *
 * - Review Hub Enhancements (#2683, #2684): opens from worktree card,
 *   displays diff mode toggle (working tree vs base branch), and closes.
 *
 * - Worktree Sidebar Layout (#2756, #2765): create-worktree button
 *   anchored in the sidebar header, filter popover accessible.
 *
 * Not tested here (requires hardware or network):
 * - Voice input improvements (audio recording hardware)
 * - GitHub issue selector (requires API token)
 * - SQLite project registry (internal migration, no visible UI change)
 * - Project relocation (complex dialog mocking, low ROI for e2e)
 */

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

import { openSettings } from "../helpers/panels";
let ctx: AppContext;

test.describe.serial("Core: v0.3.0 Features", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({
      name: "v030-features",
      withFeatureBranch: true,
      withMultipleFiles: true,
      withImageFile: true,
      withUncommittedChanges: true,
    });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "v0.3.0 Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Worktree Sidebar Search (4 tests) ──────────────────
  // Tests the persistent inline search bar added in #2748 and #2762.
  // The search input lives in the sidebar and filters worktree cards
  // with a 200ms debounce. A clear button resets search and filters.

  test.describe.serial("Worktree Sidebar Search", () => {
    test("search bar is visible in sidebar", async () => {
      const { window } = ctx;

      const searchInput = window.locator(SEL.worktree.searchInput);
      await expect(searchInput).toBeVisible({ timeout: T_LONG });
    });

    test("typing in search bar filters worktrees", async () => {
      const { window } = ctx;

      // "main" should match the main branch worktree card
      const searchInput = window.locator(SEL.worktree.searchInput);
      await searchInput.click();
      await searchInput.fill("main");

      // Wait for debounce (200ms) + render
      await window.waitForTimeout(T_SETTLE);

      const cards = window.locator("[data-worktree-branch]");
      await expect(cards.first()).toBeVisible({ timeout: T_MEDIUM });
    });

    test("clearing search shows all worktrees again", async () => {
      const { window } = ctx;

      const clearBtn = window.locator(SEL.worktree.searchClear);
      await clearBtn.click();

      await window.waitForTimeout(T_SETTLE);

      const cards = window.locator("[data-worktree-branch]");
      await expect(cards.first()).toBeVisible({ timeout: T_MEDIUM });
    });

    test("search with no match shows empty state", async () => {
      const { window } = ctx;

      const searchInput = window.locator(SEL.worktree.searchInput);
      await searchInput.click();
      await searchInput.fill("nonexistent-branch-xyz");

      await window.waitForTimeout(T_SETTLE);

      // The empty state message should appear (main worktree stays pinned)
      const emptyMsg = window.locator("text=No worktrees match your filters");
      await expect(emptyMsg).toBeVisible({ timeout: T_MEDIUM });

      // Clean up: clear the search so later tests see worktree cards
      const clearBtn = window.locator(SEL.worktree.searchClear);
      await clearBtn.click();
      await expect(emptyMsg).toBeHidden({ timeout: T_MEDIUM });
    });
  });

  // ── Settings Navigation v0.3.0 (3 tests) ──────────────
  // Validates the new settings tabs added across multiple PRs (#2719, #2724)
  // and the CLI Agents subtab bar with General + per-agent subtabs.

  test.describe.serial("Settings Navigation v0.3.0", () => {
    test("settings has all new navigation tabs", async () => {
      const { window } = ctx;

      await openSettings(window);
      const heading = window.locator(SEL.settings.heading);
      await expect(heading).toBeVisible({ timeout: T_MEDIUM });

      // Verify all current navigation tabs are clickable
      const navTabs = [
        "Notifications",
        "Worktree",
        "Toolbar",
        "Integrations",
        "MCP Server",
        "Privacy & Data",
        "Environment",
      ];

      for (const nav of navTabs) {
        const navBtn = window.locator(`${SEL.settings.navSidebar} button`, { hasText: nav });
        await expect(navBtn).toBeVisible({ timeout: T_SHORT });
        await navBtn.click();
        await window.waitForTimeout(200);
      }
    });

    test("CLI Agents tab shows dropdown selector with General active by default", async () => {
      const { window } = ctx;

      // Navigate to CLI Agents tab
      const agentsNav = window.locator(`${SEL.settings.navSidebar} button`, {
        hasText: "CLI Agents",
      });
      await agentsNav.click();

      // Agent selector dropdown should be visible within the agents panel
      const agentsPanel = window.locator("#settings-panel-agents");
      const dropdownTrigger = agentsPanel.locator('button[aria-haspopup="listbox"]');
      await expect(dropdownTrigger).toBeVisible({ timeout: T_MEDIUM });

      // Trigger should display "General" as the selected item
      await expect(dropdownTrigger).toContainText("General", { timeout: T_SHORT });
    });

    test("selecting agent from dropdown switches active state", async () => {
      const { window } = ctx;

      const agentsPanel = window.locator("#settings-panel-agents");
      const dropdownTrigger = agentsPanel.locator('button[aria-haspopup="listbox"]');

      // Open the dropdown
      await dropdownTrigger.click();

      // The listbox should appear with General + agent options
      const listbox = window.locator('[role="listbox"]#agent-selector-list');
      await expect(listbox).toBeVisible({ timeout: T_SHORT });
      const options = listbox.locator('[role="option"]');
      const count = await options.count();
      expect(count).toBeGreaterThanOrEqual(2);

      // Click the second option (first agent) to select it
      const agentOption = options.nth(1);
      const agentName = await agentOption.textContent();
      await agentOption.click();

      // Dropdown should close and trigger should show the selected agent name
      await expect(listbox).not.toBeVisible({ timeout: T_SHORT });
      await expect(dropdownTrigger).toContainText(agentName!.trim(), { timeout: T_SHORT });

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Settings Search (3 tests) ──────────────────────────
  // The settings dialog gained a search input (#2719) that filters
  // all settings entries and switches the content pane to "Search Results".

  test.describe.serial("Settings Search", () => {
    test("search input is visible in settings", async () => {
      const { window } = ctx;

      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      const searchInput = window.locator(SEL.settings.searchInput);
      await expect(searchInput).toBeVisible({ timeout: T_SHORT });
    });

    test("typing a query switches to search results view", async () => {
      const { window } = ctx;

      const searchInput = window.locator(SEL.settings.searchInput);
      await searchInput.click();
      await searchInput.fill("font");

      await window.waitForTimeout(T_SETTLE);

      // Content heading should switch from the tab title to "Search Results"
      await expect(window.locator('h3:has-text("Search Results")')).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("clearing search returns to normal navigation", async () => {
      const { window } = ctx;

      const clearBtn = window.locator(SEL.settings.searchClear);
      await clearBtn.click();

      await window.waitForTimeout(T_SETTLE);

      // Search Results heading should disappear, normal tab heading returns
      await expect(window.locator('h3:has-text("Search Results")')).not.toBeVisible({
        timeout: T_SHORT,
      });

      // Nav sidebar should be functional again
      const navSidebar = window.locator(SEL.settings.navSidebar);
      await expect(navSidebar.locator("button", { hasText: "General" })).toBeVisible({
        timeout: T_SHORT,
      });

      await window.keyboard.press("Escape");
    });
  });

  // ── Review Hub (3 tests) ───────────────────────────────
  // Tests the Review Hub overlay opened from the worktree card (#2683, #2684).
  // The Review Hub shows changed files, a diff mode toggle (working tree vs
  // base branch), and a close button. PR state badge is visible when a PR
  // is linked (not testable offline).

  test.describe.serial("Review Hub", () => {
    test("worktree card has Review & Commit button", async () => {
      const { window } = ctx;

      // Ensure at least one worktree card is visible
      const cards = window.locator("[data-worktree-branch]");
      await expect(cards.first()).toBeVisible({ timeout: T_LONG });

      // The git-commit icon button appears once workspace polling detects uncommitted changes
      const reviewBtn = window.locator(SEL.worktree.reviewHubButton);
      await expect(reviewBtn.first()).toBeVisible({ timeout: T_LONG });
    });

    test("clicking Review & Commit opens Review Hub overlay", async () => {
      const { window } = ctx;

      const reviewBtn = window.locator(SEL.worktree.reviewHubButton);
      await reviewBtn.first().click();

      // Review Hub is identified by aria-labelledby="review-hub-title"
      const reviewHub = window.locator(SEL.reviewHub.container);
      await expect(reviewHub).toBeVisible({ timeout: T_MEDIUM });
    });

    test("Review Hub has diff mode selector and can be closed", async () => {
      const { window } = ctx;

      // Diff mode toggle group (working tree / vs base branch)
      const diffModeGroup = window.locator(SEL.reviewHub.diffMode);
      await expect(diffModeGroup).toBeVisible({ timeout: T_SHORT });

      // Close button with data-testid="review-hub-close"
      const closeBtn = window.locator(SEL.reviewHub.close);
      await expect(closeBtn).toBeVisible({ timeout: T_SHORT });

      await closeBtn.click();
      await expect(window.locator(SEL.reviewHub.container)).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Worktree Sidebar Layout (2 tests) ──────────────────
  // Tests the sidebar header changes: plus button anchored to the right
  // edge (#2765) and filter popover accessibility (#2762).

  test.describe.serial("Worktree Sidebar Layout", () => {
    test("create worktree button is visible in sidebar header", async () => {
      const { window } = ctx;

      // The plus button was re-anchored to the right edge of the header in #2765
      const newBtn = window.locator('button[aria-label="Create new worktree"]');
      await expect(newBtn).toBeVisible({ timeout: T_MEDIUM });
    });

    test("worktree filter popover opens and shows sort options", async () => {
      const { window } = ctx;

      // The filter button opens a popover with sort/filter options
      const filterBtn = window.locator(SEL.worktree.filterButton);
      await expect(filterBtn).toBeVisible({ timeout: T_MEDIUM });

      await filterBtn.click();

      // The popover should appear with sort radio buttons
      const popover = window.locator(SEL.worktree.filterPopover);
      await expect(popover).toBeVisible({ timeout: T_SHORT });

      // Should have at least one sort option (radio button)
      const sortOption = popover.locator('[role="radio"]').first();
      await expect(sortOption).toBeVisible({ timeout: T_SHORT });

      await window.keyboard.press("Escape");
    });
  });
});
