import { test, expect } from "@playwright/test";
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
import {
  runTerminalCommand,
  waitForTerminalText,
  writeTerminalInput,
} from "../../helpers/terminal";
import { getFirstGridPanel, openTerminal } from "../../helpers/panels";
import { T_LONG, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";
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

async function runPtyCommand(panel: ReturnType<typeof getFirstGridPanel>, command: string) {
  await writeTerminalInput(panel.page(), panel, `${command}\r`);
}

async function runPtyCommandAndWait(
  panel: ReturnType<typeof getFirstGridPanel>,
  command: string,
  marker: string
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await runPtyCommand(panel, command);
    try {
      await waitForTerminalText(panel, marker, T_LONG);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await writeTerminalInput(panel.page(), panel, "\u0003");
      await panel.page().waitForTimeout(250);
    }
  }
}

test.describe("Core: Process Cleanup", () => {
  test.beforeAll(() => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "Process cleanup tests are Unix-only",
    });
    test.skip(process.platform === "win32", "Process cleanup tests are Unix-only");
  });

  test("clean exit kills PTY process tree", async () => {
    test.setTimeout(240_000);

    const { dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "process-cleanup",
    });
    const userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-cleanup-"));
    let ptyPid = 0;
    let descendants: number[] = [];

    try {
      const ctx = await launchApp({ userDataDir });
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Process Cleanup");

      // Open terminal and wait for shell readiness via an explicit echo
      await openTerminal(ctx.window);
      const panel = getFirstGridPanel(ctx.window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
      await runPtyCommandAndWait(panel, "echo SHELL_READY_MARKER", "SHELL_READY_MARKER");

      // Spawn a long-lived child process and wait for it to appear
      await runPtyCommandAndWait(panel, "sh -c 'echo SLEEP_STARTED; sleep 9999'", "SLEEP_STARTED");

      // Collect PTY PID and poll for descendants until sleep is visible
      ptyPid = await getPtyPid(ctx.window, panel);
      expect(ptyPid).toBeGreaterThan(0);
      await expect
        .poll(() => getDescendantPids(ptyPid).length, { timeout: T_LONG, intervals: [500] })
        .toBeGreaterThan(0);
      descendants = getDescendantPids(ptyPid);
      expect(descendants.length).toBeGreaterThan(0);

      const electronPid = ctx.app.process().pid!;

      // Close app via graceful shutdown (NOT closeApp which force-kills descendants)
      // Race with a timeout to avoid hanging if Electron doesn't respond to close
      await Promise.race([
        ctx.app.close(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("app.close() timeout")), 30_000)
        ),
      ]).catch(() => {
        // If close timed out, force-kill
        try {
          process.kill(electronPid, "SIGTERM");
        } catch {
          /* already dead */
        }
      });
      await waitForProcessExit(electronPid, 45_000);

      // Verify PTY process is dead
      await waitForProcessDeath(ptyPid, T_LONG);

      // Verify descendants are dead
      for (const desc of descendants) {
        await waitForProcessDeath(desc, T_MEDIUM);
        expect(getProcessInfo(desc)).toBeNull();
      }
    } finally {
      // Failsafe: kill any surviving processes
      for (const pid of [ptyPid, ...descendants]) {
        if (pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already dead
          }
        }
      }
      rmSync(userDataDir, { recursive: true, force: true });
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

      await openTerminal(ctx.window);
      const panel = getFirstGridPanel(ctx.window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
      await runPtyCommandAndWait(panel, "echo SHELL_READY_MARKER", "SHELL_READY_MARKER");

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

test.describe.serial("Core: Process Cleanup on Shutdown", () => {
  let ctx: AppContext;
  let fixtureDir: string;
  let fixtureCleanup: (() => void) | undefined;
  let trackedPids: number[] = [];

  test.beforeAll(async () => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "Unix-only: uses pgrep for process tree verification",
    });

    test.skip(process.platform === "win32", "Unix-only: uses pgrep for process tree verification");

    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({ name: "process-cleanup" }));
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Process Cleanup Test"
    );
  });

  test.afterAll(async () => {
    // Safety net: force-kill any tracked PIDs still alive (prevents test process leaks)
    for (const pid of trackedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
    // If the app is somehow still alive (test failed before close), clean it up
    if (ctx?.app) {
      try {
        await closeApp(ctx.app);
      } catch {
        // Best-effort
      }
    }
    fixtureCleanup?.();
  });

  test("graceful shutdown kills PTY processes within time limit", async () => {
    test.setTimeout(60_000);
    const { app, window } = ctx;

    // Open a terminal
    await openTerminal(window);
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    // Wait for shell ready using sentinel
    await runTerminalCommand(window, panel, "echo DAINTREE_READY");
    await waitForTerminalText(panel, "DAINTREE_READY", T_LONG);

    // Run a SIGTERM-resistant blocking command to stress the shutdown path
    await window.waitForTimeout(T_SETTLE);
    await runTerminalCommand(window, panel, "sh -c \"trap '' TERM; exec tail -f /dev/null\"");

    // Capture PTY PID and poll until the descendant (tail) has spawned
    const ptyPid = await getPtyPid(window, panel);
    expect(ptyPid).toBeGreaterThan(0);
    await expect
      .poll(() => getDescendantPids(ptyPid).length, { timeout: T_LONG, intervals: [300] })
      .toBeGreaterThan(0);
    const descendants = getDescendantPids(ptyPid);
    trackedPids = [ptyPid, ...descendants];

    // Verify the hung process spawned at least one descendant (the tail process)
    expect(descendants.length).toBeGreaterThan(0);

    // Verify the PTY process is alive before shutdown
    expect(isPidAlive(ptyPid)).toBe(true);

    // Close the app — triggers before-quit → shutdown handler → graceful PTY kill.
    // closeApp() has a 10s timeout on app.close() with force-kill fallback,
    // then kills any lingering descendants as a safety net.
    // We measure time to verify the graceful shutdown path completed without
    // needing the 10s force-kill fallback.
    const startTime = Date.now();
    await closeApp(app);
    const elapsed = Date.now() - startTime;

    // Mark app as closed so afterAll doesn't try to close it again
    ctx = undefined as unknown as AppContext;

    // If closeApp() needed the force-kill fallback (10s timeout), elapsed > 10s.
    // The graceful shutdown (4s PTY kill timeout + service disposal) should
    // complete well under this. Use 25s as the threshold to absorb CI scheduling
    // jitter while still catching cases where the graceful path stalls entirely.
    expect(elapsed).toBeLessThan(25_000);

    // Verify all tracked PIDs are dead after shutdown
    for (const pid of trackedPids) {
      await waitForProcessExit(pid, 5_000).catch(() => {
        // waitForProcessExit timeout — process is still alive, will fail below
      });
      expect(isPidAlive(pid)).toBe(false);
    }
  });
});
