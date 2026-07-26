import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { injectFault, clearAllFaults } from "../../helpers/ipcFaults";
import {
  seedGitHubToken,
  clearGitHubToken,
  refreshGitHubConfig,
  stubRepoStats,
  restoreRepoStats,
  E2E_GITHUB_TOKEN,
} from "../../helpers/githubHelpers";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";

import { openSettings, openTerminal } from "../../helpers/panels";
let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let githubTokenSeeded = false;

test.describe.serial("Core: Silent IPC Failure Detection", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "silent-failures",
      withGitHubRemote: true,
    }));
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Silent Failures");
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
    if (githubTokenSeeded) {
      await restoreRepoStats(ctx.app);
      await clearGitHubToken(ctx.app);
      githubTokenSeeded = false;
    }
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("GitHub issues dropdown shows error state on IPC fault", async () => {
    // Seed a fake GitHub token so the renderer's no-token empty state
    // ("Add GitHub token") doesn't short-circuit the IPC path under test.
    await seedGitHubToken(ctx.app, E2E_GITHUB_TOKEN);
    githubTokenSeeded = true;
    await refreshGitHubConfig(ctx.window);

    // Pin toolbar stats to healthy counts so the issues pill stays in its
    // normal "open issues" state rather than routing clicks to Settings.
    await stubRepoStats(ctx.app, { issueCount: 2, prCount: 1, commitCount: 5 }, ctx.window);

    await injectFault(ctx.app, "forge:list-issues", "E2E_INJECTED_ERROR");

    const issuesButton = ctx.window.locator('button[aria-label*="open issues"]');
    await expect(issuesButton).toBeVisible({ timeout: T_MEDIUM });
    await issuesButton.click();

    const retryButton = ctx.window.locator('button:has-text("Retry")');
    await expect(retryButton).toBeVisible({ timeout: T_MEDIUM });

    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).not.toBeVisible();

    await ctx.window.keyboard.press("Escape");
  });

  test("diagnostics dock continues working when persistence fails", async () => {
    await ctx.window.keyboard.press("Control+Shift+J");

    const dock = ctx.window.locator(SEL.diagnostics.dock);
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });

    await injectFault(ctx.app, "app:set-state", "E2E_INJECTED_ERROR");

    const resizeHandle = ctx.window.locator(SEL.diagnostics.resizeHandle);
    await resizeHandle.focus();
    await ctx.window.keyboard.press("ArrowUp");

    await expect(dock).toBeVisible({ timeout: T_SHORT });
    await expect(ctx.window.getByRole("toolbar", { name: "Main toolbar" })).toBeVisible({
      timeout: T_SHORT,
    });
    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).not.toBeVisible({
      timeout: T_SHORT,
    });

    await clearAllFaults(ctx.app);

    const closeButton = ctx.window.locator(SEL.diagnostics.closeButton);
    await closeButton.click();
    await expect(dock).not.toBeVisible({ timeout: T_SHORT });
  });

  test("settings persist gracefully when state write fails", async () => {
    await openSettings(ctx.window);
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    const troubleshootingTab = ctx.window.locator('button:has-text("Troubleshooting")');
    await troubleshootingTab.click();

    const devModeToggle = ctx.window.locator('[aria-label="Developer Mode Toggle"]');
    await devModeToggle.scrollIntoViewIfNeeded();
    await expect(devModeToggle).toBeVisible({ timeout: T_MEDIUM });

    const initialChecked = await devModeToggle.getAttribute("aria-checked");

    await injectFault(ctx.app, "app:set-state", "E2E_INJECTED_ERROR");

    await devModeToggle.click();

    // The UI optimistically updates the toggle state even when persistence fails.
    const expectedAfter = initialChecked === "true" ? "false" : "true";
    await expect(devModeToggle).toHaveAttribute("aria-checked", expectedAfter, {
      timeout: T_SHORT,
    });
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });
    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).not.toBeVisible({
      timeout: T_SHORT,
    });

    await clearAllFaults(ctx.app);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await expect(ctx.window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  test("app survives terminal spawn fault without crashing", async () => {
    const panelsBefore = await ctx.window.locator(SEL.panel.gridPanel).count();

    await injectFault(ctx.app, "terminal:spawn", "E2E_INJECTED_ERROR");

    await openTerminal(ctx.window);

    // A panel is created optimistically before the spawn IPC call resolves.
    await expect(ctx.window.locator(SEL.panel.gridPanel)).toHaveCount(panelsBefore + 1, {
      timeout: T_MEDIUM,
    });

    // SpawnErrorBanner appears once the IPC fault propagates back to the store.
    const spawnBanner = ctx.window.locator('[role="alert"]').filter({
      has: ctx.window.locator('[aria-label="Retry starting terminal"]'),
    });
    await expect(spawnBanner).toBeVisible({ timeout: T_MEDIUM });

    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).not.toBeVisible({
      timeout: T_SHORT,
    });

    await clearAllFaults(ctx.app);

    await openSettings(ctx.window);
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  });
});
