import { test, expect } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelIds, getDockPanelIds } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_LONG } from "../helpers/timeouts";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
  realpathSync,
} from "fs";
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
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-crash-"));
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

/* ------------------------------------------------------------------ */
/*  Panel Restoration                                                  */
/* ------------------------------------------------------------------ */

const RESTORE_PANELS = {
  gridTerm: {
    id: "panel-restore-grid-1",
    kind: "terminal",
    type: "terminal",
    title: "Grid Terminal",
    location: "grid",
  },
  dockAgent: {
    id: "panel-restore-dock-1",
    kind: "agent",
    type: "claude",
    title: "Dock Agent",
    location: "dock",
  },
} as const;

function deleteProjectStateFiles(userDataDir: string): void {
  const projectsDir = path.join(userDataDir, "projects");
  if (!existsSync(projectsDir)) return;

  // Delete per-project state files so hydration falls through to the
  // migration path which uses global appState (written by restoreBackup).
  // This ensures the test validates the crash recovery restore flow.
  for (const pDir of readdirSync(projectsDir)) {
    const stateFile = path.join(projectsDir, pDir, "state.json");
    if (existsSync(stateFile)) rmSync(stateFile);
  }
}

function seedCrashDataForRestore(userDataDir: string, projectPath: string): void {
  const now = Date.now();
  const crashId = "e2e-restore-crash";

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
    errorMessage: "Restore test crash for E2E",
    errorStack: "Error: Restore test crash for E2E\n    at Object.<anonymous> (test.js:1:1)",
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

  const resolvedPath = realpathSync(projectPath);
  const terminals = Object.values(RESTORE_PANELS).map((p) => ({
    id: p.id,
    kind: p.kind,
    type: p.type,
    title: p.title,
    cwd: resolvedPath,
    worktreeId: resolvedPath,
    location: p.location,
    createdAt: now - 600_000,
  }));

  const backup = {
    capturedAt: now - 300_000,
    appState: { terminals, hasSeenWelcome: true },
  };
  writeFileSync(path.join(backupsDir, "session-state.json"), JSON.stringify(backup));
}

test.describe.serial("Core: Crash Recovery — Panel Restoration", () => {
  let ctx: AppContext | null = null;
  let userDataDir: string;
  let fixtureDir: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-restore-"));
    fixtureDir = createFixtureRepo({ name: "restore-test" });

    // Session 1: Launch, onboard project, close — establishes project in DB
    const setupCtx = await launchApp({ userDataDir });
    setupCtx.window = await openAndOnboardProject(
      setupCtx.app,
      setupCtx.window,
      fixtureDir,
      "Restore Test"
    );
    const setupPid = setupCtx.app.process().pid!;
    await closeApp(setupCtx.app);
    await waitForProcessExit(setupPid);

    // Delete per-project state files so hydration uses global appState from restoreBackup
    deleteProjectStateFiles(userDataDir);
    // Seed crash data with marker + backup containing terminals
    seedCrashDataForRestore(userDataDir, fixtureDir);

    // Session 2: Relaunch — should show crash recovery dialog
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
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  test("restore places panels in correct locations", async () => {
    const { window } = ctx!;

    // All panels should be listed in the dialog
    for (const p of Object.values(RESTORE_PANELS)) {
      await expect(window.locator(SEL.crashRecovery.panelRow(p.id))).toBeVisible({
        timeout: T_SHORT,
      });
    }

    // All panels are selected by default
    await expect(window.locator(SEL.crashRecovery.restoreSelectedButton)).toContainText(
      `Restore selected (${Object.keys(RESTORE_PANELS).length})`
    );

    // Click restore (all panels selected)
    await window.locator(SEL.crashRecovery.restoreSelectedButton).click();

    // Dialog should dismiss and main UI should appear
    await expect(window.locator(SEL.crashRecovery.dialog)).not.toBeVisible({ timeout: T_LONG });
    await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible({ timeout: T_LONG });

    // Wait for at least one panel with data-panel-id to appear
    await expect(window.locator(SEL.panel.anyPanel)).toHaveCount(2, { timeout: T_LONG });

    // Verify panels appear in correct locations by ID
    const gridIds = await getGridPanelIds(window);
    const dockIds = await getDockPanelIds(window);

    expect(gridIds).toContain(RESTORE_PANELS.gridTerm.id);
    expect(dockIds).toContain(RESTORE_PANELS.dockAgent.id);
  });

  test("clean exit does not trigger crash recovery on relaunch", async () => {
    const pid = ctx!.app.process().pid!;
    await closeApp(ctx!.app);
    await waitForProcessExit(pid);
    ctx = null;

    // Relaunch with same userDataDir — should go straight to main UI
    ctx = await launchApp({
      userDataDir,
      waitForSelector: SEL.toolbar.toggleSidebar,
    });

    // Crash dialog should NOT appear
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).toHaveCount(0);
  });
});
