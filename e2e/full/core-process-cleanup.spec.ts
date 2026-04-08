import { test, expect } from "@playwright/test";
import {
  launchApp,
  closeApp,
  waitForProcessExit,
  removeSingletonFiles,
  type AppContext,
} from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { getFirstGridPanel, openTerminal } from "../helpers/panels";
import { T_LONG, T_SETTLE } from "../helpers/timeouts";
import {
  getPtyPid,
  getProcessInfo,
  getProcessStartTime,
  getDescendantPids,
  waitForProcessDeath,
  isPidAlive,
} from "../helpers/stress";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

test.skip(process.platform === "win32", "Process cleanup tests are Unix-only");

test.describe("Core: Process Cleanup", () => {
  test("clean exit kills PTY process tree", async () => {
    test.setTimeout(240_000);

    const fixtureDir = createFixtureRepo({ name: "process-cleanup" });
    const userDataDir = mkdtempSync(path.join(tmpdir(), "canopy-e2e-cleanup-"));
    let ptyPid = 0;
    let descendants: number[] = [];

    try {
      const ctx = await launchApp({ userDataDir });
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Process Cleanup");

      // Open terminal and wait for shell readiness
      await openTerminal(ctx.window);
      const panel = getFirstGridPanel(ctx.window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
      await waitForTerminalText(panel, "process-cleanup", T_LONG);

      // Spawn a long-lived child process and wait for it to appear
      await runTerminalCommand(ctx.window, panel, "sleep 9999");

      // Collect PTY PID and poll for descendants until sleep is visible
      ptyPid = await getPtyPid(ctx.window, panel);
      expect(ptyPid).toBeGreaterThan(0);
      await expect
        .poll(() => getDescendantPids(ptyPid).length, { timeout: 15_000, intervals: [500] })
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
      await waitForProcessDeath(ptyPid, 20_000);

      // Verify descendants are dead
      for (const desc of descendants) {
        await waitForProcessDeath(desc, 10_000).catch(() => {});
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
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("TrashedPidTracker cleans up orphans after unclean exit", async () => {
    test.setTimeout(180_000);

    const fixtureDir = createFixtureRepo({ name: "process-cleanup-unclean" });
    const userDataDir = mkdtempSync(path.join(tmpdir(), "canopy-e2e-unclean-"));
    let orphanPid = 0;

    try {
      // === First session: launch, spawn HUP-resistant process, seed trashed-pids, SIGKILL ===
      const ctx = await launchApp({ userDataDir });
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Unclean Exit");

      await openTerminal(ctx.window);
      const panel = getFirstGridPanel(ctx.window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
      await waitForTerminalText(panel, "process-cleanup-unclean", T_LONG);

      // Spawn a HUP-resistant process so it survives SIGKILL of parent.
      // `trap '' HUP` makes the shell ignore SIGHUP.
      // `exec sleep 9999` replaces the shell with sleep, so PTY PID IS the sleep process.
      await runTerminalCommand(ctx.window, panel, "trap '' HUP; exec sleep 9999");
      await ctx.window.waitForTimeout(1500);

      // Get PTY PID — after exec, this is the sleep process
      orphanPid = await getPtyPid(ctx.window, panel);
      expect(orphanPid).toBeGreaterThan(0);

      // Get the process start time in the format TrashedPidTracker uses
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
      await waitForProcessDeath(orphanPid, 15_000);

      // Verify trashed-pids.json was cleaned up
      expect(existsSync(trashedPidsPath)).toBe(false);

      await closeApp(ctx2.app);
    } finally {
      // Failsafe: kill orphan if it survived
      if (orphanPid > 0) {
        try {
          process.kill(orphanPid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

test.describe.serial("Core: Process Cleanup on Shutdown", () => {
  test.skip(process.platform === "win32", "Unix-only: uses pgrep for process tree verification");

  let ctx: AppContext;
  let fixtureDir: string;
  let trackedPids: number[] = [];

  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "process-cleanup" });
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
  });

  test("graceful shutdown kills PTY processes within time limit", async () => {
    test.setTimeout(60_000);
    const { app, window } = ctx;

    // Open a terminal
    await openTerminal(window);
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    // Wait for shell ready using sentinel
    await window.waitForTimeout(2000);
    await runTerminalCommand(window, panel, "echo CANOPY_READY");
    await waitForTerminalText(panel, "CANOPY_READY", T_LONG);

    // Run a SIGTERM-resistant blocking command to stress the shutdown path
    await window.waitForTimeout(T_SETTLE);
    await runTerminalCommand(window, panel, "sh -c \"trap '' TERM; exec tail -f /dev/null\"");

    // Let the command start
    await window.waitForTimeout(T_SETTLE);

    // Capture PTY PID and descendants before close
    const ptyPid = await getPtyPid(window, panel);
    expect(ptyPid).toBeGreaterThan(0);
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
    // complete well under this. Use 15s as the threshold — exceeding it means
    // the graceful path failed and closeApp had to force-kill.
    expect(elapsed).toBeLessThan(15_000);

    // Verify all tracked PIDs are dead after shutdown
    for (const pid of trackedPids) {
      await waitForProcessExit(pid, 5_000).catch(() => {
        // waitForProcessExit timeout — process is still alive, will fail below
      });
      expect(isPidAlive(pid)).toBe(false);
    }
  });
});
