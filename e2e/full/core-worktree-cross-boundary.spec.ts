import { test, expect } from "@playwright/test";
import { launchApp, closeApp, refreshActiveWindow, type AppContext } from "../helpers/launch";
import { createFixtureRepo, createMultiProjectFixture } from "../helpers/fixtures";
import type { MultiProjectFixture } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import {
  spawnTerminalAndVerify,
  switchWorktree,
  addAndSwitchToProject,
  selectExistingProject,
} from "../helpers/workflows";
import { runTerminalCommand, waitForTerminalText, getTerminalText } from "../helpers/terminal";
import { getGridPanelIds, getPanelById } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const FEATURE = "feature/test-branch";
const FEATURE_DIR_NAME = "feature-test-branch";

// ── Block 1: Terminal CWD, Content Isolation, Overview Modal ──

test.describe.serial("Core: Cross-Worktree Terminal Isolation", () => {
  let ctx: AppContext;

  test.beforeAll(async () => {
    const fixture = createFixtureRepo({
      name: "cross-boundary",
      withFeatureBranch: true,
    });

    ctx = await launchApp();

    // Disable two-pane split mode: the test spawns 2 terminals in the
    // feature worktree, which triggers a race condition where the split
    // layout momentarily activates and crashes the Electron process.
    await ctx.window.evaluate(() => {
      localStorage.setItem(
        "daintree-two-pane-split",
        JSON.stringify({
          state: {
            config: { enabled: false, defaultRatio: 0.5, preferPreview: false },
            ratioByWorktreeId: {},
          },
          version: 1,
        })
      );
    });

    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture, "Cross Boundary");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("terminal CWD matches feature worktree path", async () => {
    const { window } = ctx;

    await test.step("switch to feature worktree", async () => {
      await switchWorktree(window, FEATURE);
    });

    const panel = await test.step("spawn terminal in feature worktree", async () => {
      return spawnTerminalAndVerify(window);
    });

    await test.step("verify pwd contains feature worktree directory name", async () => {
      await runTerminalCommand(window, panel, "pwd");
      await waitForTerminalText(panel, FEATURE_DIR_NAME);
    });
  });

  test("terminal content is isolated across worktrees", async () => {
    const { window } = ctx;

    // Switch to main worktree first
    await test.step("switch to main worktree", async () => {
      const mainCard = window.locator(SEL.worktree.mainCard);
      await mainCard.click({ position: { x: 10, y: 10 } });
      await expect
        .poll(() => mainCard.getAttribute("aria-label"), { timeout: T_LONG })
        .toContain("selected");
    });

    await spawnTerminalAndVerify(window);
    const mainPanelIds = await getGridPanelIds(window);
    const mainPanelId = mainPanelIds[mainPanelIds.length - 1];

    await test.step("echo marker in main terminal", async () => {
      // Re-acquire the panel via its stable ID — `.last()` can resolve
      // differently after the worktree switch reorders DOM nodes.
      const stableMain = getPanelById(window, mainPanelId);
      await stableMain.click({ position: { x: 100, y: 50 } });
      await window.waitForTimeout(T_SETTLE);
      await runTerminalCommand(window, stableMain, "echo MARKER_MAIN_AAA");
      await waitForTerminalText(stableMain, "MARKER_MAIN_AAA");
    });

    // Switch to feature worktree and echo a different marker
    await test.step("switch to feature worktree", async () => {
      const featureCard = window.locator(SEL.worktree.card(FEATURE));
      await featureCard.click({ position: { x: 10, y: 10 } });
      await expect
        .poll(() => featureCard.getAttribute("aria-label"), { timeout: T_LONG })
        .toContain("selected");
    });

    await spawnTerminalAndVerify(window);
    const featurePanelIds = await getGridPanelIds(window);
    const featurePanelId = featurePanelIds[featurePanelIds.length - 1];

    await test.step("echo marker in feature terminal", async () => {
      const stableFeature = getPanelById(window, featurePanelId);
      await stableFeature.click({ position: { x: 100, y: 50 } });
      await window.waitForTimeout(T_SETTLE);
      await runTerminalCommand(window, stableFeature, "echo MARKER_FEATURE_BBB");
      await waitForTerminalText(stableFeature, "MARKER_FEATURE_BBB");
    });

    // Switch back to main and verify isolation
    await test.step("verify main terminal is isolated", async () => {
      const mainCard = window.locator(SEL.worktree.mainCard);
      await mainCard.click({ position: { x: 10, y: 10 } });
      await expect
        .poll(() => mainCard.getAttribute("aria-label"), { timeout: T_LONG })
        .toContain("selected");

      const requeriedMain = getPanelById(window, mainPanelId);
      await expect(requeriedMain).toBeVisible({ timeout: T_LONG });

      // Terminals hibernate when their worktree is inactive; allow the buffer
      // to rehydrate on wake before asserting on its contents.
      await waitForTerminalText(requeriedMain, "MARKER_MAIN_AAA", T_LONG);
      const mainText = await getTerminalText(requeriedMain);
      expect(mainText).not.toContain("MARKER_FEATURE_BBB");
    });

    // Switch to feature and verify reverse isolation
    await test.step("verify feature terminal is isolated", async () => {
      const featureCard = window.locator(SEL.worktree.card(FEATURE));
      await featureCard.click({ position: { x: 10, y: 10 } });
      await expect
        .poll(() => featureCard.getAttribute("aria-label"), { timeout: T_LONG })
        .toContain("selected");

      const requeriedFeature = getPanelById(window, featurePanelId);
      await expect(requeriedFeature).toBeVisible({ timeout: T_LONG });

      await waitForTerminalText(requeriedFeature, "MARKER_FEATURE_BBB", T_LONG);
      const featureText = await getTerminalText(requeriedFeature);
      expect(featureText).not.toContain("MARKER_MAIN_AAA");
    });
  });

  test("overview modal opens and shows worktree cards", async () => {
    // Re-acquire the active window — worktree switches in the preceding
    // test may have changed the active WebContentsView.
    ctx.window = await refreshActiveWindow(ctx.app);
    const { window } = ctx;

    await window.keyboard.press(`${mod}+Shift+O`);

    const modal = window.locator(SEL.worktree.overviewModal);
    await expect(modal).toBeVisible({ timeout: T_LONG });
    await expect(modal.locator("h2", { hasText: "Worktrees Overview" })).toBeVisible();

    const cards = modal.locator("[data-worktree-branch]");
    await expect(cards.first()).toBeVisible({ timeout: T_LONG });
    await expect.poll(() => cards.count(), { timeout: T_MEDIUM }).toBeGreaterThanOrEqual(2);
  });

  test("search filtering narrows displayed worktrees in overview", async () => {
    const { window } = ctx;
    const modal = window.locator(SEL.worktree.overviewModal);

    // Ensure the modal is still open from the previous test
    await expect(modal).toBeVisible({ timeout: T_MEDIUM });

    // Ensure main worktree is visible (it may be hidden by a toggle)
    const showMainBtn = modal.locator('[aria-label="Show main worktree"]');
    if (await showMainBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await showMainBtn.click();
      await window.waitForTimeout(T_SETTLE);
    }
    // Clear any active filters
    const clearBtn = modal.locator('[aria-label="Clear all filters"]');
    if (await clearBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await clearBtn.click();
      await window.waitForTimeout(T_SETTLE);
    }

    const cards = modal.locator("[data-worktree-branch]");

    // Wait for all cards to be rendered
    await expect.poll(() => cards.count(), { timeout: T_LONG }).toBeGreaterThanOrEqual(2);

    const initialCount = await cards.count();
    expect(initialCount).toBeGreaterThanOrEqual(2);

    // Open filter popover and search
    const filterBtn = modal.locator(SEL.worktree.filterButton);
    await expect(filterBtn).toBeVisible({ timeout: T_MEDIUM });
    await filterBtn.click();
    const popover = window.locator(SEL.worktree.filterPopover);

    // Retry click if popover didn't open (can happen due to focus/z-index race)
    if (!(await popover.isVisible({ timeout: 2000 }).catch(() => false))) {
      await filterBtn.click();
    }
    await expect(popover).toBeVisible({ timeout: T_MEDIUM });

    // Wait for popover to stabilize before interacting with the search input
    await window.waitForTimeout(T_SETTLE);
    const searchInput = popover.locator('[aria-label="Search worktrees"]');
    await expect(searchInput).toBeVisible({ timeout: T_MEDIUM });

    // Search for feature branch — should narrow to 1 card
    await searchInput.click();
    await searchInput.fill("feature/test-branch");
    await window.waitForTimeout(T_SETTLE);

    await expect
      .poll(() => cards.count(), {
        timeout: T_MEDIUM,
        message: "Search should narrow to feature worktree",
      })
      .toBeLessThan(initialCount);

    // Clear search by emptying the input
    await searchInput.clear();
    await window.waitForTimeout(T_SETTLE);

    await expect
      .poll(() => cards.count(), { timeout: T_MEDIUM })
      .toBeGreaterThanOrEqual(initialCount);

    // Close popover by clicking filter button again, then close modal
    await filterBtn.click();
    await expect(popover).not.toBeVisible({ timeout: T_SHORT });

    await modal.locator(SEL.worktree.overviewClose).click();
    await expect(modal).not.toBeVisible({ timeout: T_MEDIUM });
  });
});

// ── Block 2: Active Worktree Persists Across Project Switch ──

test.describe.serial("Core: Worktree Selection Persists Across Project Switch", () => {
  let ctx: AppContext;
  let fixture: MultiProjectFixture;

  test.beforeAll(async () => {
    fixture = createMultiProjectFixture(
      { name: "project-A-cross", withFeatureBranch: true },
      { name: "project-B-cross" }
    );

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.repoA, "project-A-cross");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixture?.cleanup();
  });

  test("active worktree persists after project switch round-trip", async () => {
    test.fixme(
      true,
      "Worktree selection restore after project switch is unreliable — tracked as app bug"
    );
    test.slow();
    const { window } = ctx;

    // Select feature worktree in Project A
    await test.step("select feature worktree in Project A", async () => {
      await switchWorktree(window, FEATURE);
      const featureCard = window.locator(SEL.worktree.card(FEATURE));
      await expect
        .poll(() => featureCard.getAttribute("aria-label"), { timeout: T_LONG })
        .toContain("selected");
      // Allow time for the async worktree selection to persist to the main process
      await window.waitForTimeout(T_SETTLE * 2);
    });

    // Switch to Project B
    await test.step("switch to Project B", async () => {
      await addAndSwitchToProject(ctx.app, window, fixture.repoB, "project-B-cross");
      // Verify Project B loaded
      await expect(window.locator("[data-worktree-branch]").first()).toBeVisible({
        timeout: T_LONG,
      });
    });

    // Switch back to Project A
    await test.step("switch back to Project A", async () => {
      await selectExistingProject(window, "project-A-cross");
      await expect(window.locator("[data-worktree-branch]").first()).toBeVisible({
        timeout: T_LONG,
      });
    });

    // Verify feature worktree is still selected
    await test.step("verify feature worktree still selected", async () => {
      // Allow extra time for project hydration to restore worktree selection
      await window.waitForTimeout(T_SETTLE);

      const featureCard = window.locator(SEL.worktree.card(FEATURE));
      await expect(featureCard).toBeVisible({ timeout: T_LONG });
      await expect
        .poll(() => featureCard.getAttribute("aria-label"), {
          timeout: 30_000,
          message: "Feature worktree should still be selected after project round-trip",
        })
        .toContain("selected");
    });
  });
});

// ── Block 3: Creation Resilience & Quick-Create Palette ──

test.describe.serial("Core: Worktree Creation Resilience", () => {
  let ctx: AppContext;
  const RESILIENCE_BRANCH = "e2e/resilience-test";

  test.beforeAll(async () => {
    const fixture = createFixtureRepo({ name: "creation-resilience" });

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture, "Creation Resilience");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("existing terminal survives new worktree creation", async () => {
    const { window } = ctx;

    // Verify main worktree is selected
    const mainCard = window.locator(SEL.worktree.mainCard);
    await expect(mainCard).toBeVisible({ timeout: T_LONG });

    // Spawn terminal and run a command
    const panel = await spawnTerminalAndVerify(window);
    const panelIds = await getGridPanelIds(window);
    const originalPanelId = panelIds[panelIds.length - 1];

    await test.step("run command in existing terminal", async () => {
      await runTerminalCommand(window, panel, "echo ALIVE_CHECK");
      await waitForTerminalText(panel, "ALIVE_CHECK");
    });

    // Create a new worktree via UI
    await test.step("create new worktree via UI", async () => {
      const newBtn = window.locator('button[aria-label="Create new worktree"]');
      await newBtn.click();

      const branchInput = window.locator(SEL.worktree.branchNameInput);
      await expect(branchInput).toBeVisible({ timeout: T_MEDIUM });
      await branchInput.fill(RESILIENCE_BRANCH);

      const pathInput = window.locator('[data-testid="worktree-path-input"]');
      await expect
        .poll(
          async () => {
            const val = await pathInput.inputValue();
            return val.trim().length;
          },
          { timeout: T_LONG, message: "Worktree path should auto-populate" }
        )
        .toBeGreaterThan(0);

      const createBtn = window.locator(SEL.worktree.createButton);
      await createBtn.click();

      const newCard = window.locator(SEL.worktree.card(RESILIENCE_BRANCH));
      await expect(newCard).toBeVisible({ timeout: 30_000 });
    });

    // Verify original terminal is still functional
    await test.step("verify original terminal still works", async () => {
      // Switch back to main if needed (creation may auto-switch)
      await mainCard.click({ position: { x: 10, y: 10 } });
      await expect
        .poll(() => mainCard.getAttribute("aria-label"), { timeout: T_LONG })
        .toContain("selected");

      const originalPanel = getPanelById(window, originalPanelId);
      await expect(originalPanel).toBeVisible({ timeout: T_LONG });

      await runTerminalCommand(window, originalPanel, "echo STILL_ALIVE");
      await waitForTerminalText(originalPanel, "STILL_ALIVE");
    });
  });

  test("quick-create palette opens via action palette", async () => {
    const { window } = ctx;

    await test.step("open action palette and trigger quick create", async () => {
      await window.keyboard.press(`${mod}+Shift+P`);

      const actionPalette = window.locator(SEL.actionPalette.dialog);
      await expect(actionPalette).toBeVisible({ timeout: T_MEDIUM });

      const searchInput = window.locator(SEL.actionPalette.searchInput);
      await searchInput.fill("Quick Create Worktree");
      await window.waitForTimeout(T_SETTLE);

      const options = window.locator(SEL.actionPalette.options);
      await expect(options.first()).toBeVisible({ timeout: T_SHORT });
      await options.first().click();
    });

    await test.step("verify quick-create palette is visible", async () => {
      const quickCreate = window.locator(SEL.worktree.quickCreatePalette);
      await expect(quickCreate).toBeVisible({ timeout: T_MEDIUM });

      // Close via Escape
      await window.keyboard.press("Escape");
      await expect(quickCreate).not.toBeVisible({ timeout: T_SHORT });
    });
  });
});
