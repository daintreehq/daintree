import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import {
  waitForTerminalText,
  runTerminalCommand,
  getTerminalBufferLength,
} from "../helpers/terminal";
import { getFirstGridPanel } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG } from "../helpers/timeouts";
import { measureMainMemory, floodTerminal } from "../helpers/stress";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Output Flood Memory Bounds", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "output-flood" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Output Flood Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  let panel: ReturnType<typeof getFirstGridPanel>;

  test("terminal output flood stays memory-bounded", async () => {
    test.setTimeout(120_000);
    const { app, window } = ctx;

    await window.locator(SEL.toolbar.openTerminal).click();
    panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    await window.waitForTimeout(2000);

    const memBefore = await measureMainMemory(app, { forceGc: true });

    await floodTerminal(window, panel, { lines: 50_000 });

    const memAfter = await measureMainMemory(app, { forceGc: true });
    const memGrowthMB = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
    expect(memGrowthMB).toBeLessThan(50);
  });

  test("scrollback buffer is trimmed after flood", async () => {
    const bufferLength = await getTerminalBufferLength(panel);
    expect(bufferLength).toBeGreaterThan(0);
    // Terminal type scrollback: floor(1000 * 0.2) = 200, plus ~24 viewport rows
    expect(bufferLength).toBeLessThanOrEqual(300);
  });

  test("terminal remains interactive after flood", async () => {
    const { window } = ctx;

    await runTerminalCommand(window, panel, 'echo "POST_FLOOD_OK"');
    await waitForTerminalText(panel, "POST_FLOOD_OK");
  });
});
