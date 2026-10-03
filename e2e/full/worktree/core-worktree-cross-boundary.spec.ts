import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, refreshActiveWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { spawnTerminalAndVerify, switchWorktree } from "../../helpers/workflows";
import { runTerminalCommand, waitForTerminalText, getTerminalText } from "../../helpers/terminal";
import { getGridPanelIds, getPanelById } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const mod = process.platform === "darwin" ? "Meta" : "Control";
const FEATURE = "feature/test-branch";
const FEATURE_DIR_NAME = "feature-test-branch";

async function getPanelId(panel: Locator): Promise<string> {
  return panel.evaluate((element) => element.getAttribute("data-panel-id") ?? "");
}

async function refreshProjectWindow(ctx: AppContext): Promise<Page> {
  ctx.window = await refreshActiveWindow(ctx.app);
  return ctx.window;
}

async function switchMainWorktree(ctx: AppContext): Promise<Page> {
  const window = await refreshProjectWindow(ctx);
  await test.step("switch to main worktree", async () => {
    const mainCard = window.locator(SEL.worktree.mainCard);
    await mainCard.click({ position: { x: 10, y: 10 } });
    await expect(window.locator(SEL.worktree.mainRow)).toHaveAttribute("aria-current", "true", {
      timeout: T_LONG,
    });
  });
  return refreshProjectWindow(ctx);
}

async function switchNamedWorktree(ctx: AppContext, branchName: string): Promise<Page> {
  const window = await refreshProjectWindow(ctx);
  await switchWorktree(window, branchName);
  return refreshProjectWindow(ctx);
}

// ── Block 1: Terminal CWD and Content Isolation ──

test.describe.serial("Core: Cross-Worktree Terminal Isolation", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir: fixture, cleanup } = createFixtureRepo({
      name: "cross-boundary",
      withFeatureBranch: true,
    });
    fixtureCleanup = cleanup;

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture, "Cross Boundary");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("terminal CWD matches feature worktree path", async () => {
    const window = await switchNamedWorktree(ctx, FEATURE);

    const panel = await test.step("spawn terminal in feature worktree", async () => {
      return spawnTerminalAndVerify(window);
    });

    await test.step("verify pwd contains feature worktree directory name", async () => {
      await runTerminalCommand(window, panel, "pwd");
      await waitForTerminalText(panel, FEATURE_DIR_NAME);
    });
  });

  test("terminal content is isolated across worktrees", async () => {
    test.setTimeout(process.env.CI ? 180_000 : 120_000);

    // Switch to main worktree first
    let window = await switchMainWorktree(ctx);

    const mainPanel = await spawnTerminalAndVerify(window);
    const mainPanelId = await getPanelId(mainPanel);
    expect(mainPanelId).not.toBe("");

    await test.step("echo marker in main terminal", async () => {
      // Re-acquire the panel via its stable ID — `.last()` can resolve
      // differently after the worktree switch reorders DOM nodes.
      const stableMain = getPanelById(window, mainPanelId);
      await stableMain.click({ position: { x: 100, y: 50 } });
      await runTerminalCommand(window, stableMain, "echo MARKER_MAIN_AAA");
      await waitForTerminalText(stableMain, "MARKER_MAIN_AAA");
    });

    // Switch to feature worktree and echo a different marker
    window = await switchNamedWorktree(ctx, FEATURE);

    const featurePanel = await spawnTerminalAndVerify(window);
    const featurePanelId = await getPanelId(featurePanel);
    expect(featurePanelId).not.toBe("");

    await test.step("echo marker in feature terminal", async () => {
      const stableFeature = getPanelById(window, featurePanelId);
      await stableFeature.click({ position: { x: 100, y: 50 } });
      await runTerminalCommand(window, stableFeature, "echo MARKER_FEATURE_BBB");
      await waitForTerminalText(stableFeature, "MARKER_FEATURE_BBB");
    });

    // Switch back to main and verify isolation
    await test.step("verify main terminal is isolated", async () => {
      window = await switchMainWorktree(ctx);

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
      window = await switchNamedWorktree(ctx, FEATURE);

      const requeriedFeature = getPanelById(window, featurePanelId);
      await expect(requeriedFeature).toBeVisible({ timeout: T_LONG });

      await waitForTerminalText(requeriedFeature, "MARKER_FEATURE_BBB", T_LONG);
      const featureText = await getTerminalText(requeriedFeature);
      expect(featureText).not.toContain("MARKER_MAIN_AAA");
    });
  });

  test("maximizing in one worktree leaves another worktree's grid intact", async () => {
    test.setTimeout(process.env.CI ? 180_000 : 120_000);

    // Don't lean on panels spawned by earlier tests in this serial block — a
    // --grep'd run of this test alone would otherwise fail before it starts.
    async function ensureGridPanel(page: Page): Promise<string> {
      const existing = await getGridPanelIds(page);
      if (existing.length > 0) return existing[0]!;
      const panel = await spawnTerminalAndVerify(page);
      return getPanelId(panel);
    }

    let window = await switchMainWorktree(ctx);
    const restoreBtn = window.locator(SEL.panel.restore);

    const mainPanelId = await test.step("maximize the main worktree's panel", async () => {
      const panelId = await ensureGridPanel(window);
      expect(panelId).toBeTruthy();

      const panel = getPanelById(window, panelId);
      await panel.hover();
      await panel.locator(SEL.panel.maximize).first().click();
      await expect(restoreBtn.first()).toBeVisible({ timeout: T_SHORT });
      return panelId;
    });

    await test.step("the feature worktree still renders its own panels", async () => {
      window = await switchNamedWorktree(ctx, FEATURE);

      // The regression (#11183): maximize was a single global pointer, so it
      // survived the switch and ContentGrid took its maximize branch, failed to
      // find the main worktree's panel among this worktree's grid panels, and
      // rendered nothing at all — a blank screen. Reverting the fix fails
      // exactly here, on a grid with zero panels.
      const featurePanelIds = await getGridPanelIds(window);
      expect(featurePanelIds.length).toBeGreaterThan(0);
      expect(featurePanelIds).not.toContain(mainPanelId);
      await expect(getPanelById(window, featurePanelIds[0]!)).toBeVisible({ timeout: T_LONG });

      // ...and this worktree is not itself maximized: nothing leaked into it.
      await expect(window.locator(SEL.panel.restore)).toHaveCount(0, { timeout: T_SHORT });
    });

    await test.step("returning to the main worktree restores its maximized panel", async () => {
      window = await switchMainWorktree(ctx);

      await expect(window.locator(SEL.panel.restore).first()).toBeVisible({ timeout: T_LONG });
      await expect(getPanelById(window, mainPanelId)).toBeVisible({ timeout: T_LONG });
    });

    await test.step("unmaximize so later tests start from the grid", async () => {
      await window.locator(SEL.panel.restore).first().click();
      await expect(window.locator(SEL.panel.restore)).toHaveCount(0, { timeout: T_SHORT });
    });
  });
});

// ── Block 2: Creation Resilience & Quick-Create Palette ──

test.describe.serial("Core: Worktree Creation Resilience", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;
  const RESILIENCE_BRANCH = "e2e/resilience-test";

  test.beforeAll(async () => {
    const { dir: fixture, cleanup } = createFixtureRepo({ name: "creation-resilience" });
    fixtureCleanup = cleanup;

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture, "Creation Resilience");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
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
      await expect(newCard).toBeVisible({ timeout: T_LONG });
    });

    // Verify original terminal is still functional
    await test.step("verify original terminal still works", async () => {
      // Switch back to main if needed (creation may auto-switch)
      await mainCard.click({ position: { x: 10, y: 10 } });
      await expect(window.locator(SEL.worktree.mainRow)).toHaveAttribute("aria-current", "true", {
        timeout: T_LONG,
      });

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

      const quickCreateOption = window
        .locator(SEL.actionPalette.options)
        .filter({ hasText: /Quick create worktree/i })
        .first();
      await expect(quickCreateOption).toBeVisible({ timeout: T_SHORT });
      await quickCreateOption.click();
    });

    await test.step("verify quick-create palette is visible", async () => {
      const quickCreate = window.locator(SEL.worktree.quickCreatePalette);
      await expect(quickCreate).toBeVisible({ timeout: T_MEDIUM });

      await window.keyboard.press("Escape");
      await expect(quickCreate).not.toBeVisible({ timeout: T_MEDIUM });
    });
  });
});
