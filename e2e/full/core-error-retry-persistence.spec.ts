/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect, type Page } from "@playwright/test";
import {
  launchApp,
  closeApp,
  waitForProcessExit,
  removeSingletonFiles,
  type AppContext,
} from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../helpers/timeouts";
import type { ElectronApplication } from "@playwright/test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
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
  isTransient: boolean;
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
    id: `e2e-retry-${Date.now()}-${errorSeq}`,
    timestamp: Date.now(),
    type: "unknown",
    message: "E2E retry test error",
    isTransient: false,
    dismissed: false,
    ...overrides,
  };
}

async function emitError(
  app: ElectronApplication,
  overrides: Partial<ErrorPayload> = {}
): Promise<ErrorPayload> {
  const payload = buildError(overrides);
  // The renderer lives in a WebContentsView since the migration, so dispatch
  // to every alive webContents instead of just the BrowserWindow's main one.
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

async function getStoreErrorId(window: Page, message: string): Promise<string> {
  const id = await window.evaluate((msg) => {
    const errors = (window as any).__CANOPY_E2E_ERROR_STORE__?.() ?? [];
    const found = errors.find((e: any) => e.message === msg);
    return found?.id ?? null;
  }, message);
  if (!id) throw new Error(`Error with message "${message}" not found in store`);
  return id;
}

async function clearErrorsAndCloseDock(window: Page) {
  const dock = window.locator(SEL.diagnostics.dock);
  if (await dock.isVisible().catch(() => false)) {
    const clearButton = window.locator('button:has-text("Clear All")');
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
  await window.waitForTimeout(200);
}

/* ---------- retry & cancellation tests ---------- */

let ctx: AppContext;

test.describe.serial("Core: Error Retry & Cancellation", () => {
  test.beforeAll(async () => {
    ctx = await launchApp({ env: { CANOPY_E2E_FAULT_MODE: "1" } });
  });

  test.afterEach(async () => {
    await clearErrorsAndCloseDock(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("retry progress UI shows retrying state and cancel button", async () => {
    const msg = `Progress indicator test ${Date.now()}`;
    await emitError(ctx.app, {
      type: "git",
      message: msg,
      source: "ProgressTest",
      isTransient: true,
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
    await ctx.window.waitForTimeout(200);

    const errorRow = panel.locator("tr").filter({ hasText: msg });
    await expect(errorRow.getByText("Retrying 1/3...")).toBeVisible({ timeout: T_SHORT });
    await expect(errorRow.locator('button:text-is("Cancel")')).toBeVisible();
    await expect(errorRow.locator('button:text-is("Retry")')).not.toBeVisible();
  });

  test("successful retry clears error from problems panel", async () => {
    const msg = `Transient failure test ${Date.now()}`;
    await emitError(ctx.app, {
      type: "git",
      message: msg,
      source: "SuccessTest",
      isTransient: true,
      retryAction: "terminal",
    });

    const dock = ctx.window.locator(SEL.diagnostics.dock);
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });

    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    const errorRow = panel.locator("tr").filter({ hasText: msg });
    const retryButton = errorRow.locator('button:text-is("Retry")');
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
      isTransient: true,
      retryAction: "terminal",
    });

    const dock = ctx.window.locator(SEL.diagnostics.dock);
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });

    const panel = ctx.window.locator(SEL.diagnostics.panel("problems"));
    await expect(panel.getByText(msg)).toBeVisible({ timeout: T_SHORT });

    const storeId = await getStoreErrorId(ctx.window, msg);

    // Send synthetic progress to show retrying state
    await emitRetryProgress(ctx.app, { id: storeId, attempt: 2, maxAttempts: 3 });
    await ctx.window.waitForTimeout(200);

    const errorRow = panel.locator("tr").filter({ hasText: msg });
    await expect(errorRow.getByText("Retrying 2/3...")).toBeVisible({ timeout: T_SHORT });

    // Click Cancel
    const cancelButton = errorRow.locator('button:text-is("Cancel")');
    await cancelButton.click();

    // Progress should disappear
    await expect(errorRow.getByText(/Retrying/)).not.toBeVisible({ timeout: T_SHORT });

    // Error should still be in the panel
    await expect(panel.getByText(msg)).toBeVisible();

    // Retry button should be visible again
    await expect(errorRow.locator('button:text-is("Retry")')).toBeVisible({ timeout: T_SHORT });
  });
});

/* ---------- persistence test ---------- */

test.describe.serial("Core: Error Persistence Across Restart", () => {
  let userDataDir: string;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "canopy-e2e-error-persist-"));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    rmSync(userDataDir, { recursive: true, force: true });
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
      isTransient: false,
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
      const errors = (window as any).__CANOPY_E2E_ERROR_STORE__?.() ?? [];
      const found = errors.find(
        (e: any) => e.message === "Critical config error from previous session"
      );
      return found?.fromPreviousSession ?? false;
    });
    expect(fromPrevSession).toBe(true);
  });
});
