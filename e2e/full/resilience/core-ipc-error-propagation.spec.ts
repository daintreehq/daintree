/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
/**
 * Error surfaces: how main-process errors, retry progress, injected IPC faults
 * and terminal spawn failures reach the user — the Diagnostics dock's Problems
 * rows, the notification inbox, the per-panel SpawnErrorBanner and the GitHub
 * dropdown's error state — and that pending errors survive a restart.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  launchApp,
  closeApp,
  waitForProcessExit,
  removeSingletonFiles,
  type AppContext,
} from "../../helpers/launch";
import { injectFault, clearAllFaults } from "../../helpers/ipcFaults";
import {
  seedGitHubToken,
  clearGitHubToken,
  refreshGitHubConfig,
  stubRepoStats,
  restoreRepoStats,
  E2E_GITHUB_TOKEN,
} from "../../helpers/githubHelpers";
import { SEL } from "../../helpers/selectors";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelIds, getPanelById, openSettings, openTerminal } from "../../helpers/panels";
import { waitForTerminalReady } from "../../helpers/terminal";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import type { ElectronApplication } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";

/* ---------- helpers ---------- */

interface ErrorPayload {
  id: string;
  timestamp: number;
  type: string;
  message: string;
  details?: string;
  source?: string;
  context?: Record<string, unknown>;
  retryability: "auto" | "user-gated" | "exhausted" | "none";
  dismissed: boolean;
  retryAction?: string;
  retryArgs?: Record<string, unknown>;
  correlationId?: string;
  recoveryHint?: string;
  fromPreviousSession?: boolean;
}

let errorSeq = 0;

function buildError(overrides: Partial<ErrorPayload> = {}): ErrorPayload {
  errorSeq += 1;
  return {
    id: `e2e-err-${Date.now()}-${errorSeq}`,
    timestamp: Date.now(),
    type: "unknown",
    message: "E2E test error",
    retryability: "none",
    dismissed: false,
    ...overrides,
  };
}

// The renderer lives in a WebContentsView, so dispatch to every alive
// webContents instead of just the BrowserWindow's main one.
async function emitError(
  app: ElectronApplication,
  overrides: Partial<ErrorPayload> = {}
): Promise<ErrorPayload> {
  const payload = buildError(overrides);
  await app.evaluate(({ webContents }, err) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send("error:notify", err);
    }
  }, payload);
  return payload;
}

async function emitRetryProgress(
  app: ElectronApplication,
  progress: { id: string; attempt: number; maxAttempts: number }
) {
  await app.evaluate(({ webContents }, p) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send("error:retry-progress", p);
    }
  }, progress);
}

async function emitSpawnResult(
  app: ElectronApplication,
  terminalId: string,
  errorCode: string,
  message: string
) {
  await app.evaluate(
    ({ webContents }, { id, code, msg }) => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        wc.send("events:push", {
          name: "terminal:spawn-result",
          payload: [
            id,
            {
              success: false,
              id,
              error: { code, message: msg },
            },
          ],
        });
      }
    },
    { id: terminalId, code: errorCode, msg: message }
  );
}

async function startSpawnResultRecording(window: Page) {
  await window.evaluate(() => {
    const state = window as any;
    state.__DAINTREE_E2E_SPAWN_RESULTS__?.dispose?.();
    const results: Array<{ id: string; success: boolean }> = [];
    const dispose = globalThis.window.electron.terminal.onSpawnResult((id, result) => {
      results.push({ id, success: result.success });
    });
    state.__DAINTREE_E2E_SPAWN_RESULTS__ = { results, dispose };
  });
}

async function waitForSuccessfulSpawnResult(window: Page, terminalId: string) {
  try {
    await expect
      .poll(
        () =>
          window.evaluate(
            (id) =>
              (window as any).__DAINTREE_E2E_SPAWN_RESULTS__?.results?.some(
                (result: { id: string; success: boolean }) => result.id === id && result.success
              ) ?? false,
            terminalId
          ),
        { timeout: T_LONG }
      )
      .toBe(true);
  } finally {
    await window.evaluate(() => {
      const state = window as any;
      state.__DAINTREE_E2E_SPAWN_RESULTS__?.dispose?.();
      delete state.__DAINTREE_E2E_SPAWN_RESULTS__;
    });
  }
}

async function getErrorStoreCount(window: Page): Promise<number> {
  return window.evaluate(() => {
    return (window as any).__DAINTREE_E2E_ERROR_STORE__?.()?.length ?? 0;
  });
}

async function openRecoveryMenu(
  window: Page,
  banner: Locator,
  expectedButtonLabels: string[]
): Promise<void> {
  const trigger = banner.locator('[aria-label="More recovery options"]');
  await expect(trigger).toBeVisible();
  await trigger.hover();
  // The deferred Radix menu can remount after the first pointer interaction.
  // Use the menu's aria-expanded state below: the tooltip sharing this trigger
  // can overwrite data-state with "closed" while the menu is open.

  const menu = window
    .locator("[data-radix-popper-content-wrapper]")
    .filter({
      has: window.getByRole("menuitem", { name: expectedButtonLabels[0], exact: true }),
    })
    .last();

  await expect(async () => {
    // A failed attempt can leave the controlled menu open while its portal
    // is remounting. Close it before retrying so the next click always opens.
    if ((await trigger.getAttribute("aria-expanded", { timeout: T_SHORT })) === "true") {
      await window.keyboard.press("Escape");
      await expect(trigger).toHaveAttribute("aria-expanded", "false", { timeout: T_SHORT });
    }

    await trigger.click({ timeout: T_SHORT });
    await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: T_SHORT });
    await expect(menu).toBeVisible({ timeout: T_SHORT });
    for (const label of expectedButtonLabels) {
      await expect(menu.getByRole("menuitem", { name: label, exact: true })).toBeVisible({
        timeout: T_SHORT,
      });
    }
  }).toPass({ timeout: T_LONG });

  await window.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false", { timeout: T_SHORT });
}

async function getStoreErrorId(window: Page, message: string): Promise<string> {
  const id = await window.evaluate((msg) => {
    const errors = (window as any).__DAINTREE_E2E_ERROR_STORE__?.() ?? [];
    const found = errors.find((e: any) => e.message === msg);
    return found?.id ?? null;
  }, message);
  if (!id) throw new Error(`Error with message "${message}" not found in store`);
  return id;
}

async function clearErrorsAndCloseDock(window: Page) {
  const dock = window.locator(SEL.diagnostics.dock);
  if (await dock.isVisible().catch(() => false)) {
    const clearButton = window.locator('button:has-text("Dismiss all")');
    if (await clearButton.isVisible().catch(() => false)) {
      if (await clearButton.isEnabled().catch(() => false)) {
        await clearButton.click();
      }
    }
    const closeBtn = window.locator(SEL.diagnostics.closeButton);
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    }
  }
  // Confirm the dock has reached a stable closed state before the next serial
  // test runs, so leftover error rows can't leak across tests.
  await expect(dock).not.toBeVisible({ timeout: T_SHORT });
}

// Opens a terminal and returns the panel it created. Resolving "the last grid
// panel" instead races the new panel's mount under load and can pick up an
// older panel whose spawn result was never recorded.
async function openNewTerminal(window: Page): Promise<{ panel: Locator; terminalId: string }> {
  const before = new Set(await getGridPanelIds(window));
  await openTerminal(window);
  let terminalId = "";
  await expect
    .poll(
      async () => {
        terminalId = (await getGridPanelIds(window)).find((id) => !before.has(id)) ?? "";
        return terminalId;
      },
      { timeout: T_LONG }
    )
    .not.toBe("");
  const panel = getPanelById(window, terminalId);
  await expect(panel).toBeVisible({ timeout: T_LONG });
  return { panel, terminalId };
}

/* ---------- live-session error surfaces ---------- */

let ctx: AppContext;
const fixtureCleanups: Array<() => void> = [];
let githubTokenSeeded = false;

test.describe.serial("Core: Error surfaces", () => {
  test.beforeAll(async () => {
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
    if (githubTokenSeeded) {
      await restoreRepoStats(ctx.app);
      await clearGitHubToken(ctx.app);
      githubTokenSeeded = false;
    }
    await clearErrorsAndCloseDock(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of fixtureCleanups.splice(0)) {
      cleanup();
    }
  });

  test("git error opens diagnostics dock and shows in problems panel with recovery hint", async () => {
    // AC 1: Git error row with type "Git" and recovery hint
    // AC 5: DiagnosticsDock auto-opens when first error appears
    const dock = ctx.window.locator(SEL.diagnostics.dock);
    await expect(dock).not.toBeVisible();

    await emitError(ctx.app, {
      type: "git",
      message: "Authentication failed for repository",
      source: "GitService",
      retryability: "auto",
      retryAction: "git",
      recoveryHint: "Check your Git credentials or SSH key configuration.",
    });

    // Dock should auto-open
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });

    // Problems tab should be active
    const problemsTab = ctx.window.locator(SEL.diagnostics.tab("problems"));
    await expect(problemsTab).toHaveAttribute("aria-selected", "true");

    // Error row should show "Git" type label
    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    await expect(panel.getByRole("cell", { name: "Git", exact: true })).toBeVisible();

    // Error message should be visible
    await expect(panel.getByText("Authentication failed for repository")).toBeVisible();

    // Recovery hint should be visible
    await expect(
      panel.getByText("Check your Git credentials or SSH key configuration.")
    ).toBeVisible();
  });

  test("network error appears in notification history", async () => {
    // AC 2: Network failure produces a notification (history entry with priority "low")
    await emitError(ctx.app, {
      type: "network",
      message: "ECONNREFUSED: connection refused",
      source: "GitHubService",
    });

    // The bell aria-label includes "unread" when the error was routed to the inbox
    const bell = ctx.window.locator(SEL.notifications.bellButton);
    await expect(bell).toHaveAttribute("aria-label", /unread/, { timeout: T_SHORT });

    // Click the bell to open notification center
    await bell.click();

    // The notification center renders in a FixedDropdown portal.
    // Look for the error inside the surface-overlay container. The renderer
    // routes errors through humanizeAppError, which maps `type: "network"` to
    // a friendly title — the raw IPC message ("ECONNREFUSED: ...") is
    // intentionally never piped to UI copy (see shared/utils/errorMessage.ts).
    // The notification center splits into "Needs attention" + "Chronological"
    // sections, so the title appears in both — assert against the chronological
    // history section, which is the surface this test is named after.
    const dropdownContent = ctx.window.locator(".surface-overlay");
    await expect(dropdownContent).toBeVisible({ timeout: T_SHORT });
    await expect(
      dropdownContent.getByTestId("chrono-section").getByText("Network problem")
    ).toBeVisible({ timeout: T_SHORT });

    // Close notification center by clicking the bell again
    await bell.click();
    await expect(dropdownContent).not.toBeVisible({ timeout: T_SHORT });
  });

  test("transient error shows Retry button, permanent error does not", async () => {
    // AC 6: Transient errors display differently from permanent errors

    // Emit a transient error with retryAction
    await emitError(ctx.app, {
      type: "git",
      message: "ETIMEDOUT: connection timed out",
      source: "GitService",
      retryability: "auto",
      retryAction: "git",
    });

    // Emit a permanent error (no retryAction)
    await emitError(ctx.app, {
      type: "config",
      message: "Invalid configuration file",
      source: "ConfigService",
      retryability: "none",
    });

    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    await expect(panel).toBeVisible({ timeout: T_MEDIUM });

    // The transient error row should have a Retry button
    const transientRow = panel.locator("tr").filter({ hasText: "ETIMEDOUT" });
    await expect(transientRow.locator('button:has-text("Retry")')).toBeVisible();

    // The permanent error row should NOT have a Retry button
    const permanentRow = panel.locator("tr").filter({ hasText: "Invalid configuration file" });
    await expect(permanentRow.locator('button:has-text("Retry")')).not.toBeVisible();
  });

  test("error deduplication within 500ms window", async () => {
    // AC 7: 5 identical errors within 500ms result in only 1 displayed
    const payload = buildError({
      type: "git",
      message: "E2E dedup test error",
      source: "DeduplicationTest",
      retryability: "none",
    });

    // Send 5 identical errors in a single evaluate to ensure they arrive within 500ms
    await ctx.app.evaluate(
      ({ webContents }, { basePayload }) => {
        const targets = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed());
        for (let i = 0; i < 5; i++) {
          const err = {
            ...basePayload,
            id: `dedup-${Date.now()}-${i}`,
            timestamp: Date.now(),
          };
          for (const wc of targets) wc.send("error:notify", err);
        }
      },
      { basePayload: payload }
    );

    // Poll until the store settles — deduplication collapses 5 identical messages to 1
    await expect.poll(() => getErrorStoreCount(ctx.window), { timeout: T_MEDIUM }).toBe(1);

    // Only 1 row visible in the problems panel
    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    await expect(panel).toBeVisible({ timeout: T_MEDIUM });
    const rows = panel.locator("tbody tr").filter({ hasText: "E2E dedup test error" });
    await expect(rows).toHaveCount(1);

    // Wait past the dedup window (1000ms margin for CI — timestamp refreshes on each dup)
    // timer: errorStore ERROR_RATE_LIMIT_MS (500ms) dedup window
    await ctx.window.waitForTimeout(1000);
    await emitError(ctx.app, {
      type: "git",
      message: "E2E dedup test error",
      source: "DeduplicationTest",
      retryability: "none",
    });

    await expect.poll(() => getErrorStoreCount(ctx.window), { timeout: T_MEDIUM }).toBe(2);
  });

  test("retry progress UI shows retrying state and cancel button", async () => {
    const msg = `Progress indicator test ${Date.now()}`;
    await emitError(ctx.app, {
      type: "git",
      message: msg,
      source: "ProgressTest",
      retryability: "auto",
      retryAction: "terminal",
    });

    const dock = ctx.window.locator(SEL.diagnostics.dock);
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });

    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    await expect(panel.getByText(msg)).toBeVisible({ timeout: T_SHORT });

    // Get the store-generated ID for synthetic progress
    const storeId = await getStoreErrorId(ctx.window, msg);

    // Send synthetic retry progress
    await emitRetryProgress(ctx.app, { id: storeId, attempt: 1, maxAttempts: 3 });

    const errorRow = panel.locator("tr").filter({ hasText: msg });
    await expect(errorRow.getByText("Retrying automatically (attempt 1 of 3)")).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(errorRow.getByRole("button", { name: "Cancel retry" })).toBeVisible();
    await expect(errorRow.getByRole("button", { name: "Retry", exact: true })).not.toBeVisible();
  });

  test("successful retry clears error from problems panel", async () => {
    const msg = `Transient failure test ${Date.now()}`;
    // "worktree" routes the retry through a main-process action
    // (worktreeService.refresh) that resolves successfully; "terminal" would
    // guard-return without retryArgs. No project is open yet, so the refresh has
    // nothing to reconcile: this covers the problems panel's retry-to-cleared
    // flow, not the refresh itself.
    await emitError(ctx.app, {
      type: "git",
      message: msg,
      source: "SuccessTest",
      retryability: "auto",
      retryAction: "worktree",
    });

    const dock = ctx.window.locator(SEL.diagnostics.dock);
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });

    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    const errorRow = panel.locator("tr").filter({ hasText: msg });
    const retryButton = errorRow.getByRole("button", { name: "Retry", exact: true });
    await expect(retryButton).toBeVisible({ timeout: T_SHORT });

    await retryButton.click();

    // Error should be removed after successful retry
    await expect(errorRow).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("cancel retry stops progress and error remains", async () => {
    const msg = `Cancellation test ${Date.now()}`;
    await emitError(ctx.app, {
      type: "git",
      message: msg,
      source: "CancelTest",
      retryability: "auto",
      retryAction: "terminal",
    });

    const dock = ctx.window.locator(SEL.diagnostics.dock);
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });

    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    await expect(panel.getByText(msg)).toBeVisible({ timeout: T_SHORT });

    const storeId = await getStoreErrorId(ctx.window, msg);

    // Send synthetic progress to show retrying state
    await emitRetryProgress(ctx.app, { id: storeId, attempt: 2, maxAttempts: 3 });

    const errorRow = panel.locator("tr").filter({ hasText: msg });
    await expect(errorRow.getByText("Retrying automatically (attempt 2 of 3)")).toBeVisible({
      timeout: T_MEDIUM,
    });

    // Click Cancel
    const cancelButton = errorRow.getByRole("button", { name: "Cancel retry" });
    await cancelButton.click();

    // Progress should disappear
    await expect(errorRow.getByText(/Retrying/)).not.toBeVisible({ timeout: T_SHORT });

    // Error should still be in the panel
    await expect(panel.getByText(msg)).toBeVisible();

    // Retry button should be visible again
    await expect(errorRow.getByRole("button", { name: "Retry", exact: true })).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("GitHub issues dropdown shows error state on IPC fault", async () => {
    // The project stays open for every remaining test in this describe.
    const { dir: repo, cleanup } = createFixtureRepo({
      name: "silent-failures",
      withGitHubRemote: true,
    });
    fixtureCleanups.push(cleanup);
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repo, "Silent Failures");

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
    const heightBefore = await resizeHandle.getAttribute("aria-valuenow");
    await resizeHandle.focus();
    await ctx.window.keyboard.press("ArrowUp");
    await expect(resizeHandle).not.toHaveAttribute("aria-valuenow", heightBefore ?? "", {
      timeout: T_SHORT,
    });

    // Keep the fault installed until the height write has actually run and failed.
    // timer: DiagnosticsDock diagnosticsHeight persist debounce (300ms)
    await ctx.window.waitForTimeout(600);

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

    // A failed save is surfaced inline and the toggle rolls back to the value
    // that is actually persisted, rather than showing a change that was lost.
    await expect(
      ctx.window.getByText("Developer settings couldn't be saved. Try again.")
    ).toBeVisible({ timeout: T_MEDIUM });
    await expect(devModeToggle).toHaveAttribute("aria-checked", initialChecked ?? "false", {
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
    const idsBefore = new Set(await getGridPanelIds(ctx.window));

    await injectFault(ctx.app, "terminal:spawn", "E2E_INJECTED_ERROR");

    await openTerminal(ctx.window);

    // A panel is created optimistically before the spawn IPC call resolves.
    await expect(ctx.window.locator(SEL.panel.gridPanel)).toHaveCount(idsBefore.size + 1, {
      timeout: T_MEDIUM,
    });
    const newId = (await getGridPanelIds(ctx.window)).find((id) => !idsBefore.has(id));
    expect(newId).toBeTruthy();

    // SpawnErrorBanner appears on the new panel once the IPC fault propagates
    // back to the store. Earlier tests leave banners on other panels.
    const spawnBanner = getPanelById(ctx.window, newId!)
      .locator('[role="alert"]')
      .filter({
        has: ctx.window.locator('[aria-label="Retry starting terminal"]'),
      });
    await expect(spawnBanner).toBeVisible({ timeout: T_MEDIUM });

    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).not.toBeVisible({
      timeout: T_SHORT,
    });

    await clearAllFaults(ctx.app);

    await openSettings(ctx.window);
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    // The spawn-banner tests that follow need the panel grid reachable.
    await ctx.window.locator(SEL.settings.closeButton).click();
    await expect(ctx.window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });

  test("ENOENT spawn error shows SpawnErrorBanner with retry and trash", async () => {
    // AC 3: Terminal spawn ENOENT renders SpawnErrorBanner
    // We need a project open to spawn terminals
    // Record before opening, so the real spawn result cannot arrive unseen.
    await startSpawnResultRecording(ctx.window);
    const { panel: targetPanel, terminalId } = await openNewTerminal(ctx.window);

    // Wait for the real spawn-result success before injecting a synthetic
    // failure. Otherwise it can arrive afterward and clear the banner.
    await waitForSuccessfulSpawnResult(ctx.window, terminalId);
    await waitForTerminalReady(ctx.window, targetPanel, T_LONG);

    // Send a synthetic spawn error result for this terminal
    await emitSpawnResult(ctx.app, terminalId, "ENOENT", "spawn /nonexistent ENOENT");

    // SpawnErrorBanner should appear with role="alert"
    const banner = targetPanel.locator('[role="alert"]');
    await expect(banner).toBeVisible({ timeout: T_MEDIUM });

    // Title should say "Couldn't find shell or command"
    await expect(banner.getByText("Couldn't find shell or command")).toBeVisible();

    // Retry and Trash buttons should be visible
    await expect(banner.locator('[aria-label="Retry starting terminal"]')).toBeVisible();
    await openRecoveryMenu(ctx.window, banner, ["Trash terminal"]);
  });

  test("ENOTDIR spawn error shows Change directory action", async () => {
    // AC 4: Terminal spawn ENOTDIR renders SpawnErrorBanner with "Change directory"
    // Project must be open from previous test — fail fast if not
    await expect(ctx.window.locator(SEL.panel.gridPanel).first()).toBeVisible({
      timeout: T_SHORT,
    });
    await startSpawnResultRecording(ctx.window);
    const { panel: lastPanel, terminalId } = await openNewTerminal(ctx.window);

    await waitForSuccessfulSpawnResult(ctx.window, terminalId);
    await waitForTerminalReady(ctx.window, lastPanel, T_LONG);

    await emitSpawnResult(ctx.app, terminalId, "ENOTDIR", "ENOTDIR: not a directory");

    const banner = lastPanel.locator('[role="alert"]');
    await expect(banner).toBeVisible({ timeout: T_MEDIUM });

    // Title should say "Invalid working directory"
    await expect(banner.getByText("Invalid working directory")).toBeVisible();

    // "Change directory" button should be visible
    await expect(banner.locator('button:has-text("Change directory")')).toBeVisible();

    // Retry is demoted into overflow when Change directory is the primary action.
    await openRecoveryMenu(ctx.window, banner, ["Retry starting terminal", "Trash terminal"]);
  });
});

/* ---------- persistence across restart ---------- */

test.describe.serial("Core: Error Persistence Across Restart", () => {
  let userDataDir: string;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-error-persist-"));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
  });

  test("critical errors persist across restart", async () => {
    // Session 1: Launch app to initialize the config.json structure
    ctx = await launchApp({ userDataDir });
    await expect(ctx.window.locator(SEL.toolbar.toggleSidebar)).toBeVisible({ timeout: T_MEDIUM });

    const pid = ctx.app.process().pid!;
    await closeApp(ctx.app);
    await waitForProcessExit(pid);
    ctx = null;

    // Write a critical error to electron-store config.json between sessions
    const configPath = path.join(userDataDir, "config.json");
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    }

    const persistedError: ErrorPayload = buildError({
      type: "config",
      message: "Critical config error from previous session",
      source: "ConfigService",
      retryability: "none",
      fromPreviousSession: true,
    });

    config.pendingErrors = [persistedError];
    writeFileSync(configPath, JSON.stringify(config));

    // Clean up singleton files for relaunch
    removeSingletonFiles(userDataDir);

    // Session 2: Relaunch and verify the persisted error appears
    ctx = await launchApp({ userDataDir });

    const dock = ctx.window.locator(SEL.diagnostics.dock);
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });

    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    await expect(panel.getByText("Critical config error from previous session")).toBeVisible({
      timeout: T_MEDIUM,
    });

    // Verify fromPreviousSession flag via the E2E probe
    const fromPrevSession = await ctx.window.evaluate(() => {
      const errors = (window as any).__DAINTREE_E2E_ERROR_STORE__?.() ?? [];
      const found = errors.find(
        (e: any) => e.message === "Critical config error from previous session"
      );
      return found?.fromPreviousSession ?? false;
    });
    expect(fromPrevSession).toBe(true);
  });
});
