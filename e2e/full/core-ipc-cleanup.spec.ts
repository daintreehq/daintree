/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo, createMultiProjectFixture } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { waitForTerminalText } from "../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount, openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_SETTLE } from "../helpers/timeouts";
import {
  getTotalHandlerCount,
  getMainListenerSnapshot,
  getRendererListenerSnapshot,
} from "../helpers/ipcFaults";
import { addAndSwitchToProject, selectExistingProject } from "../helpers/workflows";
import { rmSync } from "fs";

const MONITORED_CHANNELS = [
  "worktree:update",
  "agent:state-changed",
  "terminal:activity",
  "terminal:exit",
  "terminal:data",
];

const RENDERER_CHANNELS = ["worktree:update", "agent:state-changed", "terminal:activity"];

test.describe.serial("Core: IPC Cleanup Verification", () => {
  let ctx: AppContext;
  let fixtureDir: string;

  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "ipc-cleanup" });
    ctx = await launchApp({ env: { CANOPY_E2E_FAULT_MODE: "1" } });
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "IPC Cleanup");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("AC1: handler count stable after 5 terminal open/close cycles", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    const before = await getTotalHandlerCount(ctx.app);
    if (before === null) {
      test.skip(true, "ipcMain._invokeHandlers private API unavailable");
      return;
    }

    for (let i = 0; i < 5; i++) {
      await openTerminal(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBeGreaterThan(0);

      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
      await waitForTerminalText(panel, "ipc-cleanup", T_LONG);

      await panel.locator(SEL.panel.close).first().click({ force: true });
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);
      await window.waitForTimeout(T_SETTLE);
    }

    const after = await getTotalHandlerCount(ctx.app);
    const delta = Math.abs((after ?? 0) - before);
    expect(
      delta,
      `handler count drifted by ${delta} (before=${before}, after=${after})`
    ).toBeLessThanOrEqual(1);
  });

  test("AC2: listener count stable after panel navigation cycles", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    const before = await getMainListenerSnapshot(ctx.app, MONITORED_CHANNELS);

    for (let i = 0; i < 3; i++) {
      await openTerminal(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBeGreaterThan(0);

      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
      await waitForTerminalText(panel, "ipc-cleanup", T_LONG);

      await panel.locator(SEL.panel.close).first().click({ force: true });
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(0);
      await window.waitForTimeout(T_SETTLE);
    }

    const after = await getMainListenerSnapshot(ctx.app, MONITORED_CHANNELS);

    for (const ch of MONITORED_CHANNELS) {
      const delta = Math.abs((after[ch] ?? 0) - (before[ch] ?? 0));
      expect(
        delta,
        `listener count for "${ch}" drifted by ${delta} (before=${before[ch]}, after=${after[ch]})`
      ).toBeLessThanOrEqual(1);
    }
  });

  test("AC3: renderer subscriptions stable across project switches", async () => {
    test.setTimeout(180_000);
    const { app, window } = ctx;

    const fixture = createMultiProjectFixture();

    try {
      const beforeRenderer = await getRendererListenerSnapshot(window, RENDERER_CHANNELS);

      await addAndSwitchToProject(app, window, fixture.repoB, "IPC Project B");
      await window.waitForTimeout(T_SETTLE);

      await selectExistingProject(window, "IPC Cleanup");
      await window.waitForTimeout(T_SETTLE);

      await selectExistingProject(window, "IPC Project B");
      await window.waitForTimeout(T_SETTLE);

      const afterRenderer = await getRendererListenerSnapshot(window, RENDERER_CHANNELS);

      for (const ch of RENDERER_CHANNELS) {
        const delta = Math.abs((afterRenderer[ch] ?? 0) - (beforeRenderer[ch] ?? 0));
        expect(
          delta,
          `renderer listener for "${ch}" drifted by ${delta} (before=${beforeRenderer[ch]}, after=${afterRenderer[ch]})`
        ).toBeLessThanOrEqual(1);
      }
    } finally {
      fixture.cleanup();
    }
  });

  test("AC4: main-to-renderer event fires exactly once after mount/unmount cycles", async () => {
    test.setTimeout(60_000);
    const { app, window } = ctx;

    const count = await window.evaluate(() => {
      const w = window as any;
      let counter = 0;
      let cleanup: (() => void) | null = null;

      // Simulate 5 mount/unmount cycles: subscribe, then unsubscribe
      for (let i = 0; i < 5; i++) {
        if (cleanup) cleanup();
        cleanup = w.electron.terminal.onActivity(() => {
          counter++;
        });
      }

      // After 5 cycles, exactly 1 subscription should remain (the last one)
      // Store counter ref and cleanup for later use
      w.__e2eIpcCleanupTest = { getCount: () => counter, cleanup };
      return counter;
    });

    // Counter should be 0 before any event is sent
    expect(count).toBe(0);

    // Send a single terminal:activity event from the main process
    await app.evaluate(({ BrowserWindow }) => {
      const wins = BrowserWindow.getAllWindows();
      if (wins.length > 0) {
        wins[0].webContents.send("terminal:activity", {
          terminalId: "test-terminal-id",
          headline: "e2e test",
        });
      }
    });

    await window.waitForTimeout(T_SETTLE);

    // Read the counter — should be exactly 1
    const finalCount = await window.evaluate(() => {
      const w = window as any;
      const result = w.__e2eIpcCleanupTest?.getCount() ?? -1;
      // Clean up
      w.__e2eIpcCleanupTest?.cleanup?.();
      delete w.__e2eIpcCleanupTest;
      return result;
    });

    expect(finalCount, "event should fire exactly once after 5 subscribe/unsubscribe cycles").toBe(
      1
    );
  });
});
