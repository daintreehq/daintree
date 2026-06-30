/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { clearAllFaults } from "../../helpers/ipcFaults";
import { SEL } from "../../helpers/selectors";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { openTerminal } from "../../helpers/panels";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";
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
  retryability: "auto" | "user-gated" | "exhausted" | "none";
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
    retryability: "none",
    dismissed: false,
    ...overrides,
  };
}

async function emitError(app: ElectronApplication, overrides: Partial<ErrorPayload> = {}) {
  const payload = buildError(overrides);
  await app.evaluate(({ webContents }, err) => {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) wc.send("error:notify", err);
    }
  }, payload);
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

async function getErrorStoreCount(window: Page): Promise<number> {
  return window.evaluate(() => {
    return (window as any).__DAINTREE_E2E_ERROR_STORE__?.()?.length ?? 0;
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
    await expect(window.locator(SEL.diagnostics.dock)).not.toBeVisible({ timeout: T_SHORT });
  }
}

async function openRecoveryMenu(
  window: Page,
  banner: Locator,
  expectedButtonLabels: string[]
): Promise<Locator> {
  const trigger = banner.locator('[aria-label="More recovery options"]');
  await expect(trigger).toBeVisible();

  await window.keyboard.press("Escape").catch(() => undefined);

  const menu = window
    .locator("[data-radix-popper-content-wrapper]")
    .filter({
      has: window.getByRole("button", { name: expectedButtonLabels[0], exact: true }),
    })
    .last();

  let opened = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Lead with a DOM-level click: it re-resolves the locator each call and
    // only needs the trigger momentarily attached, so it survives the banner
    // re-rendering and detaching the button mid-action. Leading with focus()
    // (the prior form) retried against the detaching node until its 30s
    // timeout on headless Linux/Windows under release load.
    await trigger.evaluate((element: HTMLElement) => element.click()).catch(() => undefined);
    if (await menu.isVisible({ timeout: T_MEDIUM }).catch(() => false)) {
      opened = true;
      break;
    }
    // Keyboard fallback in case the click landed during a re-render and was
    // dropped; focus is best-effort and must not block on a detaching node.
    await trigger.focus({ timeout: T_SHORT }).catch(() => undefined);
    await window.keyboard.press(attempt % 2 === 0 ? "Enter" : "Space").catch(() => undefined);
    if (await menu.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      opened = true;
      break;
    }
    await window.keyboard.press("Escape").catch(() => undefined);
  }

  expect(opened).toBe(true);
  await expect(menu).toBeVisible({ timeout: T_MEDIUM });
  for (const label of expectedButtonLabels) {
    await expect(menu.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  return menu;
}

/* ---------- tests ---------- */

let ctx: AppContext;
const deferredFixtureCleanups: Array<() => void> = [];

test.describe.serial("Core: IPC Error Propagation", () => {
  test.beforeAll(async () => {
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
  });

  test.afterEach(async () => {
    await clearAllFaults(ctx.app);
    await clearErrorsAndCloseDock(ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    for (const cleanup of deferredFixtureCleanups.splice(0)) {
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
    await expect(dropdownContent).toBeVisible({ timeout: 3000 });
    await expect(
      dropdownContent.getByTestId("chrono-section").getByText("Network problem")
    ).toBeVisible({ timeout: 3000 });

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
    await expect(panel).toBeVisible({ timeout: 5000 });
    const rows = panel.locator("tbody tr").filter({ hasText: "E2E dedup test error" });
    await expect(rows).toHaveCount(1);

    // Wait past the dedup window (1000ms margin for CI — timestamp refreshes on each dup)
    await ctx.window.waitForTimeout(1000);
    await emitError(ctx.app, {
      type: "git",
      message: "E2E dedup test error",
      source: "DeduplicationTest",
      retryability: "none",
    });

    await expect.poll(() => getErrorStoreCount(ctx.window), { timeout: T_MEDIUM }).toBe(2);
  });

  test("ENOENT spawn error shows SpawnErrorBanner with retry and trash", async () => {
    // AC 3: Terminal spawn ENOENT renders SpawnErrorBanner
    // We need a project open to spawn terminals
    const { dir: repo, cleanup } = createFixtureRepo({ name: "spawn-error-test" });
    deferredFixtureCleanups.push(cleanup);
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, repo, "SpawnErrorTest");

    // Click open terminal to create a terminal panel
    await openTerminal(ctx.window);

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

    // Title should say "Couldn't find shell or command"
    await expect(banner.getByText("Couldn't find shell or command")).toBeVisible();

    // Retry and Trash buttons should be visible
    await expect(banner.locator('[aria-label="Retry starting terminal"]')).toBeVisible();
    await openRecoveryMenu(ctx.window, banner, ["Move to trash"]);
  });

  test("ENOTDIR spawn error shows Change directory action", async () => {
    // AC 4: Terminal spawn ENOTDIR renders SpawnErrorBanner with "Change directory"
    // Project must be open from previous test — fail fast if not
    await expect(ctx.window.locator(SEL.panel.gridPanel).first()).toBeVisible({
      timeout: T_SHORT,
    });
    await openTerminal(ctx.window);

    const gridPanel = ctx.window.locator(SEL.panel.gridPanel);
    const lastPanel = gridPanel.last();
    await expect(lastPanel).toBeVisible({ timeout: 5000 });

    const terminalId = await lastPanel.getAttribute("data-panel-id");
    expect(terminalId).toBeTruthy();

    await emitSpawnResult(ctx.app, terminalId!, "ENOTDIR", "ENOTDIR: not a directory");

    const banner = lastPanel.locator('[role="alert"]');
    await expect(banner).toBeVisible({ timeout: 5000 });

    // Title should say "Invalid working directory"
    await expect(banner.getByText("Invalid working directory")).toBeVisible();

    // "Change directory" button should be visible
    await expect(banner.locator('[aria-label="Update working directory"]')).toBeVisible();

    // Retry is demoted into overflow when Change directory is the primary action.
    await openRecoveryMenu(ctx.window, banner, ["Retry starting terminal", "Move to trash"]);
  });
});
