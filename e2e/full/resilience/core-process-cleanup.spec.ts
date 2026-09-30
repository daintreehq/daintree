import { test, expect, type Locator, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import {
  launchApp,
  closeApp,
  waitForProcessExit,
  removeSingletonFiles,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { waitForTerminalText, writeTerminalInput } from "../../helpers/terminal";
import { getGridPanelIds, getPanelById, openTerminal } from "../../helpers/panels";
import { T_LONG } from "../../helpers/timeouts";
import {
  getPtyPid,
  getProcessInfo,
  getProcessStartTime,
  getDescendantPids,
  waitForProcessDeath,
  isPidAlive,
} from "../../helpers/stress";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

async function runPtyCommandAndWait(panel: Locator, command: string, marker: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await writeTerminalInput(panel.page(), panel, `${command}\r`);
    try {
      await waitForTerminalText(panel, marker, T_LONG);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await writeTerminalInput(panel.page(), panel, "\u0003");
    }
  }
}

async function openNewTerminal(page: Page): Promise<Locator> {
  const before = new Set(await getGridPanelIds(page));
  await openTerminal(page);
  let newId = "";
  await expect
    .poll(
      async () => {
        newId = (await getGridPanelIds(page)).find((id) => !before.has(id)) ?? "";
        return newId;
      },
      { timeout: T_LONG }
    )
    .not.toBe("");
  const panel = getPanelById(page, newId);
  await expect(panel).toBeVisible({ timeout: T_LONG });
  return panel;
}

// Records a terminal's PTY pid and waits for its long-lived child to appear.
async function recordPtyTree(page: Page, panel: Locator): Promise<number[]> {
  const ptyPid = await getPtyPid(page, panel);
  expect(ptyPid).toBeGreaterThan(0);
  await expect
    .poll(() => getDescendantPids(ptyPid).length, { timeout: T_LONG, intervals: [300] })
    .toBeGreaterThan(0);
  expect(isPidAlive(ptyPid)).toBe(true);
  return [ptyPid, ...getDescendantPids(ptyPid)];
}

test.describe("Core: Process Cleanup", () => {
  test.beforeAll(() => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "Process cleanup tests are Unix-only",
    });
    test.skip(process.platform === "win32", "Process cleanup tests are Unix-only");
  });

  test("graceful shutdown kills every PTY process tree within the time limit", async () => {
    test.setTimeout(240_000);

    const { dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "process-cleanup",
    });
    let ctx: AppContext | null = null;
    let trackedPids: number[] = [];

    try {
      ctx = await launchApp();
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Process Cleanup");
      const { app, window } = ctx;

      // An ordinary long-lived child.
      const sleepPanel = await openNewTerminal(window);
      // Markers are split with empty quotes so only the shell's output, not the
      // echoed input line, can satisfy the wait.
      await runPtyCommandAndWait(sleepPanel, 'echo SHELL_READY_""MARKER', "SHELL_READY_MARKER");
      await runPtyCommandAndWait(
        sleepPanel,
        "sh -c 'echo SLEEP_STAR\"\"TED; sleep 9999'",
        "SLEEP_STARTED"
      );
      const sleepTree = await recordPtyTree(window, sleepPanel);

      // A child that ignores SIGTERM, to stress the escalation path.
      const tailPanel = await openNewTerminal(window);
      await runPtyCommandAndWait(tailPanel, 'echo DAINTREE_""READY', "DAINTREE_READY");
      await runPtyCommandAndWait(
        tailPanel,
        "sh -c \"trap '' TERM; echo TAIL_STAR''TED; exec tail -f /dev/null\"",
        "TAIL_STARTED"
      );
      const tailTree = await recordPtyTree(window, tailPanel);

      trackedPids = [...sleepTree, ...tailTree];
      const electronPid = app.process().pid!;

      // Quit through the app's own shutdown path. closeApp() is not used here:
      // it force-kills every descendant itself, which would hide a broken
      // shutdown. A close that hangs fails the test rather than being rescued.
      const startTime = Date.now();
      let closeTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => {
            closeTimer = setTimeout(
              () => reject(new Error("app.close() did not finish within 25s")),
              25_000
            );
          }),
        ]);
      } finally {
        clearTimeout(closeTimer);
      }
      await waitForProcessExit(electronPid, T_LONG);
      ctx = null;

      // One deadline covers the quit and every recorded process dying. The
      // graceful path (PTY kill timeout + service disposal) should finish well
      // inside it; the margin absorbs CI scheduling jitter.
      for (const pid of trackedPids) {
        await waitForProcessDeath(pid, Math.max(1_000, 25_000 - (Date.now() - startTime)));
        expect(getProcessInfo(pid)).toBeNull();
      }
      expect(Date.now() - startTime).toBeLessThan(25_000);
    } finally {
      for (const pid of trackedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      if (ctx?.app) await closeApp(ctx.app).catch(() => undefined);
      fixtureCleanup();
    }
  });

  test("TrashedPidTracker cleans up orphans after unclean exit", async () => {
    test.setTimeout(180_000);

    const { dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "process-cleanup-unclean",
    });
    const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-unclean-"));
    let orphanPid = 0;
    let orphanProcess: ChildProcess | undefined;

    try {
      // === First session: launch, seed trashed-pids, SIGKILL ===
      const ctx = await launchApp({ userDataDir });
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Unclean Exit");

      const panel = await openNewTerminal(ctx.window);
      await runPtyCommandAndWait(panel, 'echo SHELL_READY_""MARKER', "SHELL_READY_MARKER");

      // TrashedPidTracker only needs a live PID/start-time entry from a previous
      // session. Use a test-owned detached process so this assertion is not
      // coupled to PTY-host crash reaping behavior.
      orphanProcess = spawn("sh", ["-c", "trap '' TERM HUP; exec sleep 9999"], {
        detached: true,
        stdio: "ignore",
      });
      orphanProcess.unref();
      orphanPid = orphanProcess.pid ?? 0;
      expect(orphanPid).toBeGreaterThan(0);

      // Get the process start time in the format TrashedPidTracker uses
      await expect
        .poll(() => getProcessStartTime(orphanPid), { timeout: 10_000, intervals: [100] })
        .toBeTruthy();
      const startTime = getProcessStartTime(orphanPid);
      expect(startTime).toBeTruthy();

      // Seed trashed-pids.json with the orphan's info
      const trashedPidsPath = path.join(userDataDir, "trashed-pids.json");
      const trashedEntry = [
        {
          terminalId: "e2e-test-orphan",
          pid: orphanPid,
          startTime: startTime!,
          trashedAt: Date.now(),
        },
      ];
      writeFileSync(trashedPidsPath, JSON.stringify(trashedEntry));

      // SIGKILL the Electron process (simulate crash)
      const electronPid = ctx.app.process().pid!;
      process.kill(electronPid, "SIGKILL");
      await waitForProcessExit(electronPid, 15_000);

      // Verify orphan survived the parent death
      expect(getProcessInfo(orphanPid)).not.toBeNull();

      // Clean singleton files so we can relaunch
      removeSingletonFiles(userDataDir);

      // === Second session: relaunch, verify TrashedPidTracker killed the orphan ===
      const ctx2 = await launchApp({ userDataDir });

      // initializeTrashedPidCleanup() runs before window creation,
      // so by the time launchApp resolves, cleanup has already happened
      await waitForProcessDeath(orphanPid, T_LONG);

      // Verify trashed-pids.json was cleaned up
      expect(existsSync(trashedPidsPath)).toBe(false);

      await closeApp(ctx2.app);
    } finally {
      // Failsafe: kill orphan if it survived
      if (orphanPid > 0) {
        try {
          process.kill(-orphanPid, "SIGKILL");
        } catch {
          // fall back to direct kill below
        }
        try {
          process.kill(orphanPid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      rmSync(userDataDir, { recursive: true, force: true });
      fixtureCleanup();
    }
  });
});
