/* eslint-disable @typescript-eslint/no-explicit-any -- window.electron is untyped in Playwright evaluate() */
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, createMultiProjectFixture } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { waitForTerminalText, writeTerminalInput } from "../../helpers/terminal";
import { getFirstGridPanel, getGridPanelCount, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_SETTLE } from "../../helpers/timeouts";
import {
  getTotalHandlerCount,
  getMainListenerSnapshot,
  getRendererListenerSnapshot,
} from "../../helpers/ipcFaults";
import { addAndSwitchToProject, selectExistingProjectAndRefresh } from "../../helpers/workflows";

// Migrated events (worktree:update, agent:state-changed, terminal:exit, ...)
// now travel over the multiplexed `events:push` channel so their listener
// counts are observed there, not on the per-event channel.
const MONITORED_CHANNELS = ["events:push", "terminal:activity", "terminal:data"];

const RENDERER_CHANNELS = ["events:push", "terminal:activity"];

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

test.describe.serial("Core: IPC Cleanup Verification", () => {
  let ctx: AppContext;
  let fixtureDir: string;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "ipc-cleanup" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp({ env: { DAINTREE_E2E_FAULT_MODE: "1" } });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "IPC Cleanup");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("AC1: handler count stable after 5 terminal open/close cycles", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    const before = await getTotalHandlerCount(ctx.app);
    if (before === null) {
      test.info().annotations.push({
        type: "quarantine",
        description: "2026-05-27 ipcMain._invokeHandlers private API unavailable",
      });

      test.skip(true, "ipcMain._invokeHandlers private API unavailable");
      return;
    }

    for (let i = 0; i < 5; i++) {
      await openTerminal(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBeGreaterThan(0);

      const panel = getFirstGridPanel(window);
      await expect(panel).toBeVisible({ timeout: T_LONG });
      await runPtyCommandAndWait(panel, "echo READY_" + i, "READY_" + i);

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
      await runPtyCommandAndWait(panel, "echo NAV_READY_" + i, "NAV_READY_" + i);

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

    const fixture = createMultiProjectFixture();

    try {
      const beforeRenderer = await getRendererListenerSnapshot(ctx.window, RENDERER_CHANNELS);

      ctx.window = await addAndSwitchToProject(ctx.app, ctx.window, fixture.repoB, "project-B");
      await ctx.window.waitForTimeout(T_SETTLE);

      ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, "ipc-cleanup");
      await ctx.window.waitForTimeout(T_SETTLE);

      ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, "project-B");
      await ctx.window.waitForTimeout(T_SETTLE);

      const afterRenderer = await getRendererListenerSnapshot(ctx.window, RENDERER_CHANNELS);

      for (const ch of RENDERER_CHANNELS) {
        const delta = Math.abs((afterRenderer[ch] ?? 0) - (beforeRenderer[ch] ?? 0));
        expect(
          delta,
          `renderer listener for "${ch}" drifted by ${delta} (before=${beforeRenderer[ch]}, after=${afterRenderer[ch]})`
        ).toBeLessThanOrEqual(1);
      }
    } finally {
      // Restore the base project so downstream serial tests run against a known
      // view. Capture the recovered page; keep the existing window on failure
      // rather than silently corrupting ctx.window.
      ctx.window = await selectExistingProjectAndRefresh(ctx.app, ctx.window, "ipc-cleanup").catch(
        (e) => {
          console.warn("AC3 cleanup: failed to switch back to ipc-cleanup project", e);
          return ctx.window;
        }
      );
      fixture.cleanup();
    }
  });

  test("AC4: main-to-renderer event fires exactly once after raw bridge subscribe/unsubscribe cycles", async () => {
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

    // Send a single terminal:activity event to every alive WebContents —
    // after the WebContentsView migration the renderer lives inside a
    // child view, not the BrowserWindow's main webContents, so a single
    // `wins[0].webContents.send` would miss it.
    await app.evaluate(({ webContents }) => {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) {
          wc.send("terminal:activity", {
            terminalId: "test-terminal-id",
            headline: "e2e test",
          });
        }
      }
    });

    // Poll the counter so delivery latency (slow CI, scheduler jitter, GC) is
    // tolerated; it must settle at exactly 1, never more.
    await expect
      .poll(() => window.evaluate(() => (window as any).__e2eIpcCleanupTest?.getCount() ?? -1), {
        timeout: T_LONG,
      })
      .toBe(1);

    // Read the final counter and clean up the test global.
    const finalCount = await window.evaluate(() => {
      const w = window as any;
      const result = w.__e2eIpcCleanupTest?.getCount() ?? -1;
      w.__e2eIpcCleanupTest?.cleanup?.();
      delete w.__e2eIpcCleanupTest;
      return result;
    });

    expect(finalCount, "event should fire exactly once after 5 subscribe/unsubscribe cycles").toBe(
      1
    );
  });
});
