import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_LONG } from "../helpers/timeouts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

function seedCorruptedMarker(userDataDir: string): void {
  writeFileSync(path.join(userDataDir, "running.lock"), '{"sessionStartMs":1234');
}

function seedValidMarkerWithCorruptBackup(userDataDir: string): void {
  const now = Date.now();
  const crashesDir = path.join(userDataDir, "crashes");
  const backupsDir = path.join(userDataDir, "backups");
  mkdirSync(crashesDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });

  const crashId = "e2e-corrupt-backup";
  const crashLog = {
    id: crashId,
    timestamp: now - 60_000,
    appVersion: "0.0.0-test",
    platform: process.platform,
    osVersion: "test",
    arch: process.arch,
    errorMessage: "Test crash for corrupted backup",
  };
  const crashLogPath = path.join(crashesDir, `crash-${crashId}.json`);
  writeFileSync(crashLogPath, JSON.stringify(crashLog));

  const marker = {
    sessionStartMs: now - 600_000,
    appVersion: "0.0.0-test",
    platform: process.platform,
    crashLogPath,
  };
  writeFileSync(path.join(userDataDir, "running.lock"), JSON.stringify(marker));

  writeFileSync(path.join(backupsDir, "session-state.json"), "NOT_VALID_JSON{{{{");
}

function seedStaleTmpOnly(userDataDir: string): void {
  const backupsDir = path.join(userDataDir, "backups");
  mkdirSync(backupsDir, { recursive: true });

  writeFileSync(
    path.join(backupsDir, `session-state.json.${Date.now()}.tmp`),
    JSON.stringify({ capturedAt: Date.now(), appState: { terminals: [] } })
  );
}

function seedPanelWithBogusWorktree(userDataDir: string): void {
  const now = Date.now();
  const crashesDir = path.join(userDataDir, "crashes");
  const backupsDir = path.join(userDataDir, "backups");
  mkdirSync(crashesDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });

  const crashId = "e2e-bogus-worktree";
  const crashLog = {
    id: crashId,
    timestamp: now - 60_000,
    appVersion: "0.0.0-test",
    platform: process.platform,
    osVersion: "test",
    arch: process.arch,
    errorMessage: "Test crash for bogus worktree panel",
  };
  const crashLogPath = path.join(crashesDir, `crash-${crashId}.json`);
  writeFileSync(crashLogPath, JSON.stringify(crashLog));

  const marker = {
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
          id: "panel-bogus-wt",
          kind: "terminal",
          title: "Bogus Worktree Terminal",
          cwd: "/tmp/nonexistent",
          worktreeId: "nonexistent-wt-id-12345",
          location: "grid",
          createdAt: now - 600_000,
        },
      ],
    },
  };
  writeFileSync(path.join(backupsDir, "session-state.json"), JSON.stringify(backup));
}

test.describe.serial("Core: Crash Recovery — corrupted running.lock", () => {
  let ctx: AppContext;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-corrupt-marker-"));
    seedCorruptedMarker(userDataDir);
    ctx = await launchApp({
      userDataDir,
      waitForSelector: SEL.toolbar.toggleSidebar,
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

  test("app launches normally without crash dialog", async () => {
    await expect(ctx.window.locator(SEL.toolbar.openSettings)).toBeVisible({
      timeout: T_SHORT,
    });
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).toHaveCount(0);
  });
});

test.describe.serial("Core: Crash Recovery — corrupted session backup", () => {
  let ctx: AppContext;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-corrupt-backup-"));
    seedValidMarkerWithCorruptBackup(userDataDir);
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
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).not.toBeVisible({
      timeout: T_LONG,
    });
    await expect(ctx.window.locator(SEL.toolbar.openSettings)).toBeVisible({
      timeout: T_LONG,
    });
  });
});

test.describe.serial("Core: Crash Recovery — stale tmp file", () => {
  let ctx: AppContext;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-stale-tmp-"));
    seedStaleTmpOnly(userDataDir);
    ctx = await launchApp({
      userDataDir,
      waitForSelector: SEL.toolbar.toggleSidebar,
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

  test("app launches normally ignoring stale tmp file", async () => {
    await expect(ctx.window.locator(SEL.toolbar.openSettings)).toBeVisible({
      timeout: T_SHORT,
    });
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).toHaveCount(0);
  });
});

test.describe.serial("Core: Crash Recovery — panel with non-existent worktreeId", () => {
  let ctx: AppContext;
  let userDataDir: string;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-bogus-wt-"));
    seedPanelWithBogusWorktree(userDataDir);
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

  test("restore selected button shows correct count", async () => {
    await expect(ctx.window.locator(SEL.crashRecovery.restoreSelectedButton)).toContainText(
      "Restore selected (1)"
    );
  });

  test("start fresh dismisses dialog and shows main UI", async () => {
    await ctx.window.locator(SEL.crashRecovery.freshButton).click();
    await expect(ctx.window.locator(SEL.crashRecovery.dialog)).not.toBeVisible({
      timeout: T_LONG,
    });
    await expect(ctx.window.locator(SEL.toolbar.openSettings)).toBeVisible({
      timeout: T_LONG,
    });
  });
});
