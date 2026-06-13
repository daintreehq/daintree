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
import { T_LONG } from "../../helpers/timeouts";
import { measureMainMemory, floodTerminal } from "../../helpers/stress";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: Output Flood Memory Bounds", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "output-flood" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Output Flood Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  let panel: ReturnType<typeof getFirstGridPanel>;

  test("terminal output flood stays memory-bounded", async () => {
    test.setTimeout(120_000);
    const { app, window } = ctx;

    await openTerminal(window);
    panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    // Prompt text is shell-dependent on CI; the flood only needs a live PTY.
    await waitForTerminalPty(window, panel, T_LONG);

    const memBefore = await measureMainMemory(app, { forceGc: true });

    await floodTerminal(window, panel, { lines: 50_000 });

    const memAfter = await measureMainMemory(app, { forceGc: true });
    const memGrowthMB = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
    expect(memGrowthMB).toBeLessThan(50);
  });

  test("scrollback buffer is trimmed after flood", async () => {
    const bufferLength = await getTerminalBufferLength(panel);
    expect(bufferLength).toBeGreaterThan(0);
    // Terminal type scrollback: floor(1000 * 0.3) = 300, plus ~24 viewport rows
    expect(bufferLength).toBeLessThanOrEqual(400);
  });

  test("terminal remains interactive after flood", async () => {
    const { window } = ctx;

    await runTerminalCommand(window, panel, 'echo "POST_FLOOD_OK"');
    await waitForTerminalText(panel, "POST_FLOOD_OK");
  });
});
