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
import { getFirstGridPanel } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import {
  getPtyPid,
  getProcessInfo,
  getProcessStartTime,
  getDescendantPids,
  waitForProcessDeath,
} from "../helpers/stress";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

test.skip(process.platform === "win32", "Process cleanup tests are Unix-only");

test.describe("Core: Process Cleanup", () => {
  test("clean exit kills PTY process tree", async () => {
    test.setTimeout(120_000);

    const fixtureDir = createFixtureRepo({ name: "process-cleanup" });
    const userDataDir = mkdtempSync(path.join(tmpdir(), "canopy-e2e-cleanup-"));
    let ptyPid = 0;
    let descendants: number[] = [];

    try {
      const ctx = await launchApp({ userDataDir });
      await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Process Cleanup");

      // Open terminal
      await ctx.window.locator(SEL.toolbar.openTerminal).click();
      const panel = getFirstGridPanel(ctx.window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
      await ctx.window.waitForTimeout(2000);

      // Spawn a long-lived child process
      await runTerminalCommand(ctx.window, panel, "sleep 9999");
      await ctx.window.waitForTimeout(1500);

      // Collect PTY PID and descendants
      ptyPid = await getPtyPid(ctx.window, panel);
      expect(ptyPid).toBeGreaterThan(0);
      descendants = getDescendantPids(ptyPid);

      const electronPid = ctx.app.process().pid!;

      // Close app via graceful shutdown (NOT closeApp which force-kills descendants)
      await ctx.app.close();
      await waitForProcessExit(electronPid, 30_000);

      // Verify PTY process is dead
      await waitForProcessDeath(ptyPid, 15_000);

      // Verify descendants are dead
      for (const desc of descendants) {
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
      await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Unclean Exit");

      await ctx.window.locator(SEL.toolbar.openTerminal).click();
      const panel = getFirstGridPanel(ctx.window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
      await ctx.window.waitForTimeout(2000);

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
