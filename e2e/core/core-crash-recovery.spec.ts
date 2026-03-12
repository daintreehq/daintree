import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_LONG } from "../helpers/timeouts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const PANEL_IDS = ["panel-term-1", "panel-agent-1"] as const;

interface MarkerFile {
  sessionStartMs: number;
  appVersion: string;
  platform: string;
  crashLogPath?: string;
}

interface CrashLogEntry {
  id: string;
  timestamp: number;
  appVersion: string;
  platform: string;
  osVersion: string;
  arch: string;
  errorMessage?: string;
  errorStack?: string;
}

function seedCrashData(userDataDir: string): void {
  const now = Date.now();
  const crashId = "e2e-test-crash";

  const crashesDir = path.join(userDataDir, "crashes");
  const backupsDir = path.join(userDataDir, "backups");
  mkdirSync(crashesDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });

  const crashLog: CrashLogEntry = {
    id: crashId,
    timestamp: now - 60_000,
    appVersion: "0.0.0-test",
    platform: process.platform,
    osVersion: "test",
    arch: process.arch,
    errorMessage: "Test crash error for E2E",
    errorStack: "Error: Test crash error for E2E\n    at Object.<anonymous> (test.js:1:1)",
  };
  const crashLogPath = path.join(crashesDir, `crash-${crashId}.json`);
  writeFileSync(crashLogPath, JSON.stringify(crashLog));

  const marker: MarkerFile = {
    sessionStartMs: now - 600_000,
    appVersion: "0.0.0-test",
    platform: process.platform,
    crashLogPath,
  };
  writeFileSync(path.join(userDataDir, "running.lock"), JSON.stringify(marker));

  const backup = {
    capturedAt: now - 300_000,
    appState: {
      terminals: [
        {
          id: PANEL_IDS[0],
          kind: "terminal",
          title: "Terminal 1",
          cwd: "/tmp",
          location: "grid",
          createdAt: now - 600_000,
        },
        {
          id: PANEL_IDS[1],
          kind: "agent",
          title: "Claude Agent",
          cwd: "/tmp",
          location: "dock",
          createdAt: now - 600_000,
        },
      ],
    },
  };
  writeFileSync(path.join(backupsDir, "session-state.json"), JSON.stringify(backup));
}

test.describe.serial("Core: Crash Recovery", () => {
  let ctx: AppContext;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "canopy-e2e-crash-"));
    seedCrashData(userDataDir);
    ctx = await launchApp({
      userDataDir,
      waitForSelector: SEL.crashRecovery.dialog,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  test("crash recovery dialog is visible on launch", async () => {
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("panel list shows seeded panels with correct content", async () => {
    const { window } = ctx;

    await expect(window.locator(SEL.crashRecovery.panelList)).toBeVisible({
      timeout: T_SHORT,
    });

    const termRow = window.locator(SEL.crashRecovery.panelRow(PANEL_IDS[0]));
    await expect(termRow).toBeVisible({ timeout: T_SHORT });
    await expect(termRow).toContainText("Terminal 1");
    await expect(termRow).toContainText("grid");

    const agentRow = window.locator(SEL.crashRecovery.panelRow(PANEL_IDS[1]));
    await expect(agentRow).toBeVisible({ timeout: T_SHORT });
    await expect(agentRow).toContainText("Claude Agent");
    await expect(agentRow).toContainText("dock");

    await expect(window.locator(SEL.crashRecovery.restoreSelectedButton)).toContainText(
      `Restore selected (${PANEL_IDS.length})`
    );
  });

  test("toggle-all deselects then reselects all panels", async () => {
    const { window } = ctx;

    for (const id of PANEL_IDS) {
      await expect(window.locator(SEL.crashRecovery.panelCheckbox(id))).toBeChecked();
    }

    await window.locator(SEL.crashRecovery.toggleAllButton).click();

    for (const id of PANEL_IDS) {
      await expect(window.locator(SEL.crashRecovery.panelCheckbox(id))).not.toBeChecked();
    }

    await expect(window.locator(SEL.crashRecovery.toggleAllButton)).toHaveText("Select all");

    await window.locator(SEL.crashRecovery.toggleAllButton).click();

    for (const id of PANEL_IDS) {
      await expect(window.locator(SEL.crashRecovery.panelCheckbox(id))).toBeChecked();
    }

    await expect(window.locator(SEL.crashRecovery.toggleAllButton)).toHaveText("Deselect all");
  });

  test("individual panel checkbox toggles independently", async () => {
    const { window } = ctx;
    const checkbox = window.locator(SEL.crashRecovery.panelCheckbox(PANEL_IDS[0]));

    await expect(checkbox).toBeChecked();
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();

    await expect(window.locator(SEL.crashRecovery.restoreSelectedButton)).toContainText(
      "Restore selected (1)"
    );

    await checkbox.click();
    await expect(checkbox).toBeChecked();

    await expect(window.locator(SEL.crashRecovery.restoreSelectedButton)).toContainText(
      `Restore selected (${PANEL_IDS.length})`
    );
  });

  test("error details section expands with seeded content and collapses", async () => {
    const { window } = ctx;

    await expect(window.locator(SEL.crashRecovery.detailsSection)).not.toBeVisible();

    await window.locator(SEL.crashRecovery.detailsToggle).click();
    const details = window.locator(SEL.crashRecovery.detailsSection);
    await expect(details).toBeVisible({ timeout: T_SHORT });

    await expect(details).toContainText("Test crash error for E2E");
    await expect(details).toContainText("0.0.0-test");

    await window.locator(SEL.crashRecovery.detailsToggle).click();
    await expect(details).not.toBeVisible();
  });

  test("auto-restore checkbox toggles", async () => {
    const { window } = ctx;
    const checkbox = window.locator(SEL.crashRecovery.autoRestoreCheckbox);

    await expect(checkbox).not.toBeChecked();

    await checkbox.click();
    await expect(checkbox).toBeChecked();

    await checkbox.click();
    await expect(checkbox).not.toBeChecked();
  });

  test("start fresh dismisses dialog and shows main UI", async () => {
    const { window } = ctx;

    await window.locator(SEL.crashRecovery.freshButton).click();

    await expect(window.locator(SEL.crashRecovery.dialog)).not.toBeVisible({
      timeout: T_LONG,
    });

    await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible({
      timeout: T_LONG,
    });
  });
});
