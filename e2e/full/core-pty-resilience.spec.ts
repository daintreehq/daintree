import { test, expect } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getTerminalText, waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount, openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import {
  getPtyPid,
  isPidAlive,
  getProcessInfo,
  verifyProcessIdentity,
  measureMainMemory,
  startFrameProbe,
  stopFrameProbe,
  floodTerminal,
  getTerminalStats,
  snapshotProcesses,
  diffProcessSnapshots,
} from "../helpers/stress";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: PTY Resilience", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "pty-resilience" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "PTY Resilience Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("terminal flood with PTY lifecycle verification", async () => {
    test.setTimeout(120_000);
    const { app, window } = ctx;

    // Open terminal
    await openTerminal(window);
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    // Wait for shell prompt to be ready
    await window.waitForTimeout(2000);

    // Extract PTY PID
    const ptyPid = await getPtyPid(window, panel);
    expect(ptyPid).toBeGreaterThan(0);

    // Verify PID is alive
    expect(isPidAlive(ptyPid)).toBe(true);

    // Capture baseline process identity for PID reuse safety (Unix only)
    const baseline = getProcessInfo(ptyPid);
    if (process.platform !== "win32") {
      expect(baseline).not.toBeNull();
    }

    // Capture process snapshot before stress
    const procsBefore = snapshotProcesses((e) => e.ppid === ptyPid);

    // Measure baseline memory
    const memBefore = await measureMainMemory(app, { forceGc: true });
    expect(memBefore.heapUsed).toBeGreaterThan(0);

    // Start frame probe — use try/finally to ensure cleanup
    await startFrameProbe(window);
    let frameResult;
    try {
      await floodTerminal(window, panel, { lines: 2000 });
    } finally {
      frameResult = await stopFrameProbe(window);
    }
    expect(frameResult.sampleCount).toBeGreaterThan(0);
    // Catastrophic stall threshold — generous for CI VMs
    expect(frameResult.maxGapMs).toBeLessThan(5000);

    // Measure post-stress memory
    const memAfter = await measureMainMemory(app, { forceGc: true });
    const memGrowthMB = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
    expect(memGrowthMB).toBeLessThan(50);

    // Verify terminal stats
    const stats = await getTerminalStats(window);
    expect(stats.terminalCount).toBeGreaterThanOrEqual(1);
    expect(stats.withPty).toBeGreaterThanOrEqual(1);

    // Check process snapshot diff (no leaked child processes)
    const procsAfter = snapshotProcesses((e) => e.ppid === ptyPid);
    const diff = diffProcessSnapshots(procsBefore, procsAfter);
    // Flood uses `node -e` which should exit — no persistent children expected
    expect(diff.added.length).toBeLessThanOrEqual(1);

    // Close panel
    const closeBtn = panel.locator(SEL.panel.close);
    await closeBtn.click();
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);

    // Wait for PTY process to exit (CI VMs can be slow to reap)
    await waitForProcessExit(ptyPid, 30_000);

    // Verify PID is dead or reused (not the same process, Unix only)
    if (process.platform !== "win32" && isPidAlive(ptyPid)) {
      expect(verifyProcessIdentity(ptyPid, baseline!)).toBe(false);
    }

    // Terminal stats should show no terminals with PTY
    const statsAfter = await getTerminalStats(window);
    expect(statsAfter.withPty).toBe(0);
  });

  test("memory stability across terminal open/close cycles", async () => {
    test.setTimeout(120_000);
    const { app, window } = ctx;

    // Measure baseline
    const memBaseline = await measureMainMemory(app, { forceGc: true });

    // Run 3 open/close cycles
    for (let i = 0; i < 3; i++) {
      await openTerminal(window);
      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });

      // Wait for shell to be ready (prompt char varies by shell)
      await window.waitForTimeout(2000);

      // Close panel
      const closeBtn = panel.locator(SEL.panel.close);
      await closeBtn.click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(0);
    }

    // Measure final memory
    const memFinal = await measureMainMemory(app, { forceGc: true });
    const growthMB = (memFinal.heapUsed - memBaseline.heapUsed) / (1024 * 1024);
    // 3 cycles should not leak more than 50MB
    expect(growthMB).toBeLessThan(50);
  });

  test("PTY crash mid-output: spawn terminal and start flood", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    await openTerminal(window);
    const floodPanel = getFirstGridPanel(window);
    await expect(floodPanel).toBeVisible({ timeout: T_LONG });

    // Wait for the shell to be ready
    await waitForTerminalText(floodPanel, "pty-resilience", T_LONG);

    // Capture the shell PID
    await runTerminalCommand(window, floodPanel, "echo CANOPY_PID_$$");
    await waitForTerminalText(floodPanel, "CANOPY_PID_", T_LONG);

    const text = await getTerminalText(floodPanel);
    const pidMatch = text.match(/CANOPY_PID_(\d+)/);
    expect(pidMatch).toBeTruthy();
    const capturedPid = Number(pidMatch![1]);
    expect(capturedPid).toBeGreaterThan(0);

    // Start a slow flood
    await window.waitForTimeout(T_SETTLE);
    await runTerminalCommand(
      window,
      floodPanel,
      "while true; do echo FLOOD_LINE_$(date +%s); sleep 0.05; done"
    );
    await waitForTerminalText(floodPanel, "FLOOD_LINE_", T_LONG);

    // Kill the shell process with SIGKILL
    await ctx.app.evaluate((_, pid) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ESRCH — already dead
      }
    }, capturedPid);

    // node-pty reports exitCode=null for signal deaths, normalized to 0 by TerminalProcess.
    // Exit code 0 → panel auto-trashed. Non-zero → panel preserved with exit banner.
    // Wait for either outcome: panel trashed (grid empty) or exit banner visible.
    await expect
      .poll(
        async () => {
          const count = await getGridPanelCount(window);
          if (count === 0) return "trashed";
          try {
            const panelText = await getTerminalText(floodPanel);
            if (panelText.includes("Process exited")) return "preserved";
          } catch {
            // Panel may have been removed between count check and text read
            return "trashed";
          }
          return "pending";
        },
        { timeout: 60_000, intervals: [1000] }
      )
      .toMatch(/trashed|preserved/);

    // Verify the toolbar is still interactive (app is responsive)
    await expect(window.locator(SEL.toolbar.toggleSidebar)).toBeVisible();
    await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible();
  });

  test("PTY crash mid-output: open new terminal after crash", async () => {
    const { window } = ctx;

    const countBefore = await getGridPanelCount(window);
    await openTerminal(window);

    // Wait for the new terminal to appear
    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_LONG })
      .toBeGreaterThan(countBefore);

    // Get the newest panel (last in grid — the crashed panel may still be first)
    const newPanel = window.locator(SEL.panel.gridPanel).last();
    await expect(newPanel).toBeVisible({ timeout: T_MEDIUM });

    await waitForTerminalText(newPanel, "pty-resilience", T_LONG);

    await runTerminalCommand(window, newPanel, 'echo "POST_CRASH_OK"');
    await waitForTerminalText(newPanel, "POST_CRASH_OK", T_LONG);
  });
});
