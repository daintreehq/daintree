import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../helpers/timeouts";
import { getPtyPid, isPidAlive, measureMainMemory, waitForProcessDeath } from "../helpers/stress";

const CYCLE_COUNT = 50;
const MEMORY_THRESHOLD_MB = 20;

let ctx: AppContext;
let fixtureDir: string;

async function openTerminalAndGetPid(window: AppContext["window"]): Promise<{
  panel: ReturnType<typeof getFirstGridPanel>;
  ptyPid: number;
}> {
  const countBefore = await getGridPanelCount(window);
  await window.locator(SEL.toolbar.openTerminal).click();
  await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore + 1);

  const panel = getFirstGridPanel(window);
  await expect(panel).toBeVisible({ timeout: T_MEDIUM });

  // Poll until PTY PID is assigned
  await expect
    .poll(
      async () => {
        try {
          return await getPtyPid(window, panel);
        } catch {
          return 0;
        }
      },
      { timeout: T_LONG, intervals: [500] }
    )
    .toBeGreaterThan(0);

  const ptyPid = await getPtyPid(window, panel);
  return { panel, ptyPid };
}

async function forceCloseFirstPanel(window: AppContext["window"]): Promise<void> {
  const countBefore = await getGridPanelCount(window);
  const panel = getFirstGridPanel(window);
  const closeBtn = panel.locator(SEL.panel.close);
  await closeBtn.click({ modifiers: ["Alt"] });
  await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(countBefore - 1);
}

test.describe.serial("Core: Rapid Terminal Create/Destroy Cycles", () => {
  const trackedPids: number[] = [];

  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "rapid-terminal" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Rapid Terminal Test");
  });

  test.afterAll(async () => {
    if (process.platform !== "win32") {
      for (const pid of trackedPids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already dead
        }
      }
    }
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("50 rapid create/destroy cycles with leak and memory checks", async () => {
    test.setTimeout(300_000);
    const { app, window } = ctx;

    // Baseline memory
    const memBefore = await measureMainMemory(app, { forceGc: true });

    await test.step("run 50 rapid create/destroy cycles", async () => {
      for (let i = 0; i < CYCLE_COUNT; i++) {
        const { ptyPid } = await openTerminalAndGetPid(window);
        trackedPids.push(ptyPid);
        await forceCloseFirstPanel(window);

        // Batch-check PIDs every 10 cycles (Unix only)
        if (process.platform !== "win32" && (i + 1) % 10 === 0) {
          const batchStart = i - 9;
          const batch = trackedPids.slice(batchStart, batchStart + 10);
          for (const pid of batch) {
            try {
              await waitForProcessDeath(pid, 15_000);
            } catch {
              // Will be caught in final verification
            }
          }
        }
      }
    });

    await test.step("verify no leaked PIDs", async () => {
      if (process.platform === "win32") return;

      // Allow a brief settle for the last batch
      await window.waitForTimeout(2000);

      let leakedCount = 0;
      for (const pid of trackedPids) {
        if (isPidAlive(pid)) leakedCount++;
      }
      expect(leakedCount).toBe(0);
    });

    await test.step("verify memory growth is bounded", async () => {
      const memAfter = await measureMainMemory(app, { forceGc: true });
      const growthMB = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
      expect(growthMB).toBeLessThan(MEMORY_THRESHOLD_MB);
    });

    await test.step("post-stress: new terminal is functional", async () => {
      const { panel, ptyPid } = await openTerminalAndGetPid(window);
      trackedPids.push(ptyPid);
      expect(ptyPid).toBeGreaterThan(0);

      // Wait for shell prompt, then run a command
      await window.waitForTimeout(2000);
      await runTerminalCommand(window, panel, 'echo "RAPID_STRESS_OK"');
      await waitForTerminalText(panel, "RAPID_STRESS_OK", T_LONG);

      // Clean up
      await forceCloseFirstPanel(window);
    });
  });
});
