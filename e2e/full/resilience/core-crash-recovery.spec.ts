import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelIds, getDockPanelIds } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_LONG } from "../../helpers/timeouts";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  realpathSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";

async function expectMainUiReady(page: Page, timeout = T_LONG): Promise<void> {
  await expect(page.getByRole("toolbar", { name: "Main toolbar" })).toBeVisible({ timeout });
}

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

// Opt out of auto-restore so the dialog appears. The app defaults to silent
// restore — these specs exercise the explicit-recovery path users only see
// after turning auto-restore off.
function forceAutoRestoreOff(userDataDir: string): void {
  const configPath = path.join(userDataDir, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      config = {};
    }
  }
  config.crashRecovery = { autoRestoreOnCrash: false };
  writeFileSync(configPath, JSON.stringify(config));
}

/** Writes a crash log plus a valid `running.lock` pointing at it — an unclean previous exit. */
function seedCrashMarker(
  userDataDir: string,
  crashId: string,
  errorMessage: string,
  now: number
): void {
  const crashesDir = path.join(userDataDir, "crashes");
  mkdirSync(crashesDir, { recursive: true });

  const crashLog: CrashLogEntry = {
    id: crashId,
    timestamp: now - 60_000,
    appVersion: "0.0.0-test",
    platform: process.platform,
    osVersion: "test",
    arch: process.arch,
    errorMessage,
    errorStack: `Error: ${errorMessage}\n    at Object.<anonymous> (test.js:1:1)`,
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
}

function backupsDir(userDataDir: string): string {
  const dir = path.join(userDataDir, "backups");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/* ------------------------------------------------------------------ */
/*  Dialog, panel restoration and clean exit                           */
/* ------------------------------------------------------------------ */

const RESTORE_PANELS = {
  gridTerm: {
    id: "panel-restore-grid-1",
    kind: "terminal",
    type: "terminal",
    title: "Terminal 1",
    location: "grid",
  },
  dockAgent: {
    id: "panel-restore-dock-1",
    kind: "agent",
    type: "claude",
    title: "Claude Agent",
    location: "dock",
  },
} as const;
const PANEL_IDS = [RESTORE_PANELS.gridTerm.id, RESTORE_PANELS.dockAgent.id] as const;
const CRASH_ERROR_MESSAGE = "Test crash error for E2E";

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

async function readPersistedActiveWorktreeId(page: Page): Promise<string> {
  let activeWorktreeId = "";

  await expect
    .poll(
      async () => {
        activeWorktreeId = await page.evaluate(async () => {
          const state = await window.electron.app.getState();
          return state.activeWorktreeId ?? "";
        });
        return activeWorktreeId.length;
      },
      {
        timeout: T_LONG,
        message: "active worktree id should be persisted before seeding restore data",
      }
    )
    .toBeGreaterThan(0);

  return activeWorktreeId;
}

function seedCrashDataForRestore(
  userDataDir: string,
  projectPath: string,
  restoreWorktreeId: string
): void {
  const now = Date.now();
  forceAutoRestoreOff(userDataDir);
  seedCrashMarker(userDataDir, "e2e-restore-crash", CRASH_ERROR_MESSAGE, now);

  const resolvedPath = restoreWorktreeId || realpathSync(projectPath);
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
  writeFileSync(path.join(backupsDir(userDataDir), "session-state.json"), JSON.stringify(backup));
}

test.describe.serial("Core: Crash Recovery", () => {
  let ctx: AppContext | null = null;
  let userDataDir: string;
  let fixtureDir: string;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(() => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-crash-"));
    const { dir, cleanup } = createFixtureRepo({ name: "restore-test" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    try {
      removePathSync(userDataDir);
    } catch {
      // best-effort cleanup
    }
    fixtureCleanup?.();
  });

  test("corrupted running.lock launches normally without crash dialog", async () => {
    // The first session doubles as the setup launch for the restore flow below.
    writeFileSync(path.join(userDataDir, "running.lock"), '{"sessionStartMs":1234');
    ctx = await launchApp({ userDataDir, waitForSelector: SEL.toolbar.toggleSidebar });

    await expectMainUiReady(ctx.window, T_SHORT);
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).toHaveCount(0);
  });

  test("crash recovery dialog is visible on launch", async () => {
    // Establish the project, exit cleanly, then leave the on-disk state an
    // unclean exit would: a marker plus a session backup.
    ctx!.window = await openAndOnboardProject(ctx!.app, ctx!.window, fixtureDir, "Restore Test");
    const restoreWorktreeId = await readPersistedActiveWorktreeId(ctx!.window);
    const setupPid = ctx!.app.process().pid!;
    await closeApp(ctx!.app);
    await waitForProcessExit(setupPid);
    ctx = null;

    deleteProjectStateFiles(userDataDir);
    seedCrashDataForRestore(userDataDir, fixtureDir, restoreWorktreeId);

    ctx = await launchApp({ userDataDir, waitForSelector: SEL.crashRecovery.dialog });
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("panel list shows seeded panels with correct content", async () => {
    const { window } = ctx!;

    await expect(window.locator(SEL.crashRecovery.panelList)).toBeVisible({
      timeout: T_SHORT,
    });

    const termRow = window.locator(SEL.crashRecovery.panelRow(RESTORE_PANELS.gridTerm.id));
    await expect(termRow).toBeVisible({ timeout: T_SHORT });
    await expect(termRow).toContainText("Terminal 1");
    await expect(termRow).toContainText("grid");

    const agentRow = window.locator(SEL.crashRecovery.panelRow(RESTORE_PANELS.dockAgent.id));
    await expect(agentRow).toBeVisible({ timeout: T_SHORT });
    await expect(agentRow).toContainText("Claude Agent");
    await expect(agentRow).toContainText("dock");

    await expect(window.locator(SEL.crashRecovery.restoreSelectedButton)).toContainText(
      `Restore selected (${PANEL_IDS.length})`
    );
  });

  test("toggle-all deselects then reselects all panels", async () => {
    const { window } = ctx!;

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
    const { window } = ctx!;
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
    const { window } = ctx!;

    await expect(window.locator(SEL.crashRecovery.detailsSection)).not.toBeVisible();

    await window.locator(SEL.crashRecovery.detailsToggle).click();
    const details = window.locator(SEL.crashRecovery.detailsSection);
    await expect(details).toBeVisible({ timeout: T_SHORT });

    await expect(details).toContainText(CRASH_ERROR_MESSAGE);
    await expect(details).toContainText("0.0.0-test");

    await window.locator(SEL.crashRecovery.detailsToggle).click();
    await expect(details).not.toBeVisible();
  });

  test("auto-restore switch toggles", async () => {
    const { window } = ctx!;
    const switchEl = window.locator(SEL.crashRecovery.autoRestoreCheckbox);

    await expect(switchEl).not.toBeChecked();

    await switchEl.click();
    await expect(switchEl).toBeChecked();

    await switchEl.click();
    await expect(switchEl).not.toBeChecked();
  });

  test("restore places panels in correct locations", async () => {
    const { window } = ctx!;

    for (const p of Object.values(RESTORE_PANELS)) {
      await expect(window.locator(SEL.crashRecovery.panelRow(p.id))).toBeVisible({
        timeout: T_SHORT,
      });
    }

    await expect(window.locator(SEL.crashRecovery.restoreSelectedButton)).toContainText(
      `Restore selected (${Object.keys(RESTORE_PANELS).length})`
    );

    await window.locator(SEL.crashRecovery.restoreSelectedButton).click();

    await expect(window.locator(SEL.crashRecovery.dialog)).not.toBeVisible({ timeout: T_LONG });
    await expectMainUiReady(window);

    await expect(window.locator(SEL.panel.anyPanel)).toHaveCount(2, { timeout: T_LONG });

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

    ctx = await launchApp({
      userDataDir,
      waitForSelector: SEL.toolbar.toggleSidebar,
    });

    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Damaged recovery state                                             */
/* ------------------------------------------------------------------ */

test.describe.serial("Core: Crash Recovery — corrupted session backup", () => {
  let ctx: AppContext;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-corrupt-backup-"));
    seedCrashMarker(
      userDataDir,
      "e2e-corrupt-backup",
      "Test crash for corrupted backup",
      Date.now()
    );
    writeFileSync(path.join(backupsDir(userDataDir), "session-state.json"), "NOT_VALID_JSON{{{{");
    ctx = await launchApp({
      userDataDir,
      waitForSelector: SEL.crashRecovery.dialog,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    try {
      removePathSync(userDataDir);
    } catch {
      // best-effort cleanup
    }
  });

  test("crash dialog shows with no-panels fallback layout", async () => {
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).toBeVisible({
      timeout: T_SHORT,
    });
    await expect(ctx.window.locator(SEL.crashRecovery.panelList)).toHaveCount(0);
    await expect(ctx.window.locator(SEL.crashRecovery.restoreButton)).toBeVisible();
    await expect(ctx.window.locator(SEL.crashRecovery.freshButton)).toBeVisible();
  });

  test("start fresh dismisses dialog and shows main UI", async () => {
    await ctx.window.locator(SEL.crashRecovery.freshButton).click();
    await ctx.window.getByRole("button", { name: "Reset to clean layout" }).click();
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).not.toBeVisible({
      timeout: T_LONG,
    });
    await expectMainUiReady(ctx.window);
  });
});

const STALE_TMP_PANEL_ID = "panel-stale-tmp";

// A real crash whose backup lists one panel with a worktreeId that no longer
// exists, next to a newer, complete snapshot stranded as a `.tmp` by a backup
// write that never reached its rename. Recovery must read only the committed
// backup: the stranded snapshot's panel must not be offered.
function seedPanelWithBogusWorktreeAndStaleTmp(userDataDir: string): void {
  const now = Date.now();
  forceAutoRestoreOff(userDataDir);
  seedCrashMarker(userDataDir, "e2e-bogus-worktree", "Test crash for bogus worktree panel", now);

  const panel = (id: string, title: string) => ({
    id,
    kind: "terminal",
    title,
    cwd: path.join(tmpdir(), "nonexistent"),
    worktreeId: "nonexistent-wt-id-12345",
    location: "grid",
    createdAt: now - 600_000,
  });

  const dir = backupsDir(userDataDir);
  writeFileSync(
    path.join(dir, "session-state.json"),
    JSON.stringify({
      capturedAt: now - 300_000,
      appState: { terminals: [panel("panel-bogus-wt", "Bogus Worktree Terminal")] },
    })
  );
  writeFileSync(
    path.join(dir, `session-state.json.${now - 1_000}-e2etmp.tmp`),
    JSON.stringify({
      capturedAt: now - 1_000,
      appState: { terminals: [panel(STALE_TMP_PANEL_ID, "Stale Tmp Terminal")] },
    })
  );
}

test.describe.serial("Core: Crash Recovery — bogus worktreeId and stale backup tmp", () => {
  let ctx: AppContext;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-bogus-wt-"));
    seedPanelWithBogusWorktreeAndStaleTmp(userDataDir);
    ctx = await launchApp({
      userDataDir,
      waitForSelector: SEL.crashRecovery.dialog,
    });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    try {
      removePathSync(userDataDir);
    } catch {
      // best-effort cleanup
    }
  });

  test("crash dialog shows with panel listed despite bogus worktreeId", async () => {
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).toBeVisible({
      timeout: T_SHORT,
    });
    await expect(ctx.window.locator(SEL.crashRecovery.panelList)).toBeVisible({
      timeout: T_SHORT,
    });

    const panelRow = ctx.window.locator(SEL.crashRecovery.panelRow("panel-bogus-wt"));
    await expect(panelRow).toBeVisible({ timeout: T_SHORT });
    await expect(panelRow).toContainText("Bogus Worktree Terminal");
    await expect(panelRow).toContainText("grid");
  });

  test("stale backup tmp file is ignored by recovery", async () => {
    const list = ctx.window.locator(SEL.crashRecovery.panelList);
    await expect(list.locator(SEL.crashRecovery.panelRow("panel-bogus-wt"))).toBeVisible({
      timeout: T_SHORT,
    });
    await expect(ctx.window.locator(SEL.crashRecovery.panelRow(STALE_TMP_PANEL_ID))).toHaveCount(0);
    await expect(list).not.toContainText("Stale Tmp Terminal");
  });

  test("restore selected button shows correct count", async () => {
    await expect(ctx.window.locator(SEL.crashRecovery.restoreSelectedButton)).toContainText(
      "Restore selected (1)"
    );
  });

  test("start fresh dismisses dialog and shows main UI", async () => {
    await ctx.window.locator(SEL.crashRecovery.freshButton).click();
    await ctx.window.getByRole("button", { name: "Reset to clean layout" }).click();
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).not.toBeVisible({
      timeout: T_LONG,
    });
    await expectMainUiReady(ctx.window);
  });
});
