/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { clearAllFaults } from "../helpers/ipcFaults";
import { SEL } from "../helpers/selectors";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import type { ElectronApplication } from "@playwright/test";

/* ---------- helpers ---------- */

interface ErrorPayload {
  id: string;
  timestamp: number;
  type: string;
  message: string;
  details?: string;
  source?: string;
  context?: Record<string, unknown>;
  isTransient: boolean;
  dismissed: boolean;
  retryAction?: string;
  retryArgs?: Record<string, unknown>;
  correlationId?: string;
  recoveryHint?: string;
}

let errorSeq = 0;

function buildError(overrides: Partial<ErrorPayload> = {}): ErrorPayload {
  errorSeq += 1;
  return {
    id: `e2e-err-${Date.now()}-${errorSeq}`,
    timestamp: Date.now(),
    type: "unknown",
    message: "E2E test error",
    isTransient: false,
    dismissed: false,
    ...overrides,
  };
}

async function emitError(app: ElectronApplication, overrides: Partial<ErrorPayload> = {}) {
  const payload = buildError(overrides);
  await app.evaluate(({ BrowserWindow }, err) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send("error:notify", err);
  }, payload);
}

async function emitSpawnResult(
  app: ElectronApplication,
  terminalId: string,
  errorCode: string,
  message: string
) {
  await app.evaluate(
    ({ BrowserWindow }, { id, code, msg }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send("terminal:spawn-result", id, {
          success: false,
          id,
          error: { code, message: msg },
        });
      }
    },
    { id: terminalId, code: errorCode, msg: message }
  );
}

async function getErrorStoreCount(window: Page): Promise<number> {
  return window.evaluate(() => {
    return (window as any).__CANOPY_E2E_ERROR_STORE__?.()?.length ?? 0;
  });
}

async function clearErrorsAndCloseDock(window: Page) {
  // Close dock if visible
  const dock = window.locator(SEL.diagnostics.dock);
  if (await dock.isVisible().catch(() => false)) {
    // Click "Clear All" if there are errors
    const clearButton = window.locator('button:has-text("Clear All")');
    if (await clearButton.isVisible().catch(() => false)) {
      if (await clearButton.isEnabled().catch(() => false)) {
        await clearButton.click();
      }
    }
    // Close the dock
    const closeBtn = window.locator(SEL.diagnostics.closeButton);
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
    }
  }
  // Brief settle for React state updates
  await window.waitForTimeout(200);
}

/* ---------- tests ---------- */

let ctx: AppContext;

test.describe.serial("Core: IPC Error Propagation", () => {
  test.beforeAll(async () => {
    ctx = await launchApp({ env: { CANOPY_E2E_FAULT_MODE: "1" } });
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
    await clearErrorsAndCloseDock(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
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
      isTransient: true,
      retryAction: "git",
      recoveryHint: "Check your Git credentials or SSH key configuration.",
    });

    // Dock should auto-open
    await expect(dock).toBeVisible({ timeout: 5000 });

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

    // The bell badge should show the notification count
    const bell = ctx.window.locator(SEL.notifications.bellButton);
    await expect(bell).toBeVisible();

    // Click the bell to open notification center
    await bell.click();

    // The notification center renders in a FixedDropdown portal.
    // Look for the error message inside the surface-overlay container.
    const dropdownContent = ctx.window.locator(".surface-overlay");
    await expect(dropdownContent).toBeVisible({ timeout: 3000 });
    await expect(dropdownContent.getByText("ECONNREFUSED: connection refused")).toBeVisible({
      timeout: 3000,
    });

    // Close notification center by clicking the bell again
    await bell.click();
    await expect(dropdownContent).not.toBeVisible({ timeout: 2000 });
  });

  test("transient error shows Retry button, permanent error does not", async () => {
    // AC 6: Transient errors display differently from permanent errors

    // Emit a transient error with retryAction
    await emitError(ctx.app, {
      type: "git",
      message: "ETIMEDOUT: connection timed out",
      source: "GitService",
      isTransient: true,
      retryAction: "git",
    });

    // Emit a permanent error (no retryAction)
    await emitError(ctx.app, {
      type: "config",
      message: "Invalid configuration file",
      source: "ConfigService",
      isTransient: false,
    });

    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    await expect(panel).toBeVisible({ timeout: 5000 });

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
      isTransient: false,
    });

    // Send 5 identical errors in a single evaluate to ensure they arrive within 500ms
    await ctx.app.evaluate(
      ({ BrowserWindow }, { basePayload }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) return;
        for (let i = 0; i < 5; i++) {
          win.webContents.send("error:notify", {
            ...basePayload,
            id: `dedup-${Date.now()}-${i}`,
            timestamp: Date.now(),
          });
        }
      },
      { basePayload: payload }
    );

    // Wait for the errors to be processed
    await ctx.window.waitForTimeout(300);

    // Should have exactly 1 error in the store (deduplication)
    const count = await getErrorStoreCount(ctx.window);
    expect(count).toBe(1);

    // Only 1 row visible in the problems panel
    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    await expect(panel).toBeVisible({ timeout: 5000 });
    const rows = panel.locator("tbody tr").filter({ hasText: "E2E dedup test error" });
    await expect(rows).toHaveCount(1);

    // Wait past the dedup window (1000ms margin for CI — timestamp refreshes on each dup)
    await ctx.window.waitForTimeout(1000);
    await emitError(ctx.app, {
      type: "git",
      message: "E2E dedup test error",
      source: "DeduplicationTest",
      isTransient: false,
    });

    await ctx.window.waitForTimeout(300);
    const countAfter = await getErrorStoreCount(ctx.window);
    expect(countAfter).toBe(2);
  });

  test("ENOENT spawn error shows SpawnErrorBanner with retry and trash", async () => {
    // AC 3: Terminal spawn ENOENT renders SpawnErrorBanner
    // We need a project open to spawn terminals
    const repo = createFixtureRepo({ name: "spawn-error-test" });
    await openAndOnboardProject(ctx.app, ctx.window, repo, "SpawnErrorTest");

    // Click open terminal to create a terminal panel
    await ctx.window.locator(SEL.toolbar.openTerminal).click();

    // Wait for a grid panel to appear
    const gridPanel = ctx.window.locator(SEL.panel.gridPanel);
    await expect(gridPanel.first()).toBeVisible({ timeout: 10000 });

    // Get the terminal ID from the panel
    const terminalId = await gridPanel.last().getAttribute("data-panel-id");
    expect(terminalId).toBeTruthy();

    // Send a synthetic spawn error result for this terminal
    await emitSpawnResult(ctx.app, terminalId!, "ENOENT", "spawn /nonexistent ENOENT");

    // SpawnErrorBanner should appear with role="alert"
    const targetPanel = gridPanel.last();
    const banner = targetPanel.locator('[role="alert"]');
    await expect(banner).toBeVisible({ timeout: 5000 });

    // Title should say "Shell or Command Not Found"
    await expect(banner.getByText("Shell or Command Not Found")).toBeVisible();

    // Retry and Trash buttons should be visible
    await expect(banner.locator('[aria-label="Retry starting terminal"]')).toBeVisible();
    await expect(banner.locator('[aria-label="Move to trash"]')).toBeVisible();
  });

  test("ENOTDIR spawn error shows Update Directory action", async () => {
    // AC 4: Terminal spawn ENOTDIR renders SpawnErrorBanner with "Update Directory"
    // Project is already open from previous test
    await ctx.window.locator(SEL.toolbar.openTerminal).click();

    const gridPanel = ctx.window.locator(SEL.panel.gridPanel);
    const lastPanel = gridPanel.last();
    await expect(lastPanel).toBeVisible({ timeout: 5000 });

    const terminalId = await lastPanel.getAttribute("data-panel-id");
    expect(terminalId).toBeTruthy();

    await emitSpawnResult(ctx.app, terminalId!, "ENOTDIR", "ENOTDIR: not a directory");

    const banner = lastPanel.locator('[role="alert"]');
    await expect(banner).toBeVisible({ timeout: 5000 });

    // Title should say "Invalid Working Directory"
    await expect(banner.getByText("Invalid Working Directory")).toBeVisible();

    // "Update Directory" button should be visible
    await expect(banner.locator('[aria-label="Update working directory"]')).toBeVisible();

    // Retry and Trash should also be visible
    await expect(banner.locator('[aria-label="Retry starting terminal"]')).toBeVisible();
    await expect(banner.locator('[aria-label="Move to trash"]')).toBeVisible();
  });
});
