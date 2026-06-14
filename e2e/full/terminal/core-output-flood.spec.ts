import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  waitForTerminalText,
  runTerminalCommand,
  getTerminalBufferLength,
  waitForTerminalPty,
} from "../../helpers/terminal";
import { getFirstGridPanel, openTerminal } from "../../helpers/panels";
import { T_LONG, T_SETTLE } from "../../helpers/timeouts";
import { measureMainMemory, floodTerminal } from "../../helpers/stress";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let panel: ReturnType<typeof getFirstGridPanel>;

test.describe.serial("Core: Output Flood Memory Bounds", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "output-flood" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Output Flood Test");

    await openTerminal(ctx.window);
    panel = getFirstGridPanel(ctx.window);
    await expect(panel).toBeVisible({ timeout: T_LONG });
    await waitForTerminalPty(ctx.window, panel, T_LONG);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("terminal output flood stays memory-bounded", async () => {
    test.setTimeout(T_LONG * 4);
    const { app, window } = ctx;

    // Double GC before baseline so V8's incremental phases finish before the snapshot.
    await measureMainMemory(app, { forceGc: true });
    await window.waitForTimeout(T_SETTLE);
    const memBefore = await measureMainMemory(app, { forceGc: true });

    await floodTerminal(window, panel, { lines: 50_000 });

    // Double GC after flood so xterm ArrayBuffer/external allocations fully drain.
    await window.waitForTimeout(T_SETTLE);
    await measureMainMemory(app, { forceGc: true });
    await window.waitForTimeout(T_SETTLE);
    const memAfter = await measureMainMemory(app, { forceGc: true });

    const memGrowthMB = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
    expect(memGrowthMB).toBeLessThan(50);
  });

  test("scrollback buffer is trimmed after flood", async () => {
    const bufferLength = await getTerminalBufferLength(panel);
    expect(bufferLength).toBeGreaterThan(0);
    // Trimming proof: 50,000 lines were written; only a small fraction should survive.
    expect(bufferLength).toBeLessThan(2000);
  });

  test("terminal remains interactive after flood", async () => {
    const { window } = ctx;

    await runTerminalCommand(window, panel, 'echo "POST_FLOOD_OK"');
    await waitForTerminalText(panel, "POST_FLOOD_OK");
  });
});
