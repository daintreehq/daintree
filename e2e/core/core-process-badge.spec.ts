import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { runTerminalCommand, waitForTerminalText } from "../helpers/terminal";
import { getFirstGridPanel, openTerminal } from "../helpers/panels";
import { T_LONG } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

// #5813: the process icon badge (npm, pnpm, docker, node, etc.) must surface
// on plain terminals running a recognised non-agent process. The badge is
// driven by `agent:detected` events whose payload carries `processIconId`
// without `agentType`; the renderer threads that through to the panel's
// `data-detected-process-id` attribute.
test.describe.serial("Core: Process Icon Badge", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "process-badge" });
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Process Badge Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("node process running a timed script surfaces the node badge, then clears on exit", async () => {
    const { window } = ctx;
    await openTerminal(window);
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    const panelId = await panel.getAttribute("data-panel-id");
    expect(panelId).toBeTruthy();

    // Run a bounded `node` process — `node` is in PROCESS_ICON_MAP, so
    // either the process-tree detector or the shell-command fallback should
    // commit the "node" icon within the hysteresis window (~3s baseline).
    // SENTINEL_READY lets us confirm the script is actually executing.
    await runTerminalCommand(
      window,
      panel,
      `node -e "console.log('SENTINEL_READY'); setTimeout(()=>{}, 8000)"`
    );
    await waitForTerminalText(panel, "SENTINEL_READY", T_LONG);

    // Badge appears. T_LONG accommodates CI slowness plus the 1500ms-poll
    // × 2-poll hysteresis baseline.
    await expect
      .poll(
        async () => {
          return await window.evaluate(
            (id) =>
              document
                .querySelector(`[data-panel-id="${id}"]`)
                ?.getAttribute("data-detected-process-id"),
            panelId
          );
        },
        { timeout: T_LONG, intervals: [500] }
      )
      .toBe("node");

    // Badge clears after the process exits.
    await expect
      .poll(
        async () => {
          return await window.evaluate(
            (id) =>
              document
                .querySelector(`[data-panel-id="${id}"]`)
                ?.getAttribute("data-detected-process-id"),
            panelId
          );
        },
        { timeout: T_LONG, intervals: [500] }
      )
      .toBeNull();
  });
});
