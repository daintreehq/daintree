import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { waitForTerminalText } from "../helpers/terminal";
import { getGridPanelCount, getGridPanelIds, getPanelById, openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_SETTLE } from "../helpers/timeouts";

test.skip(process.platform === "win32", "Terminal isolation tests use Unix shell loops");

let ctx: AppContext;
let fixtureDir: string;
let floodPanelId: string;
let probePanelId: string;

/**
 * Write a command directly to a terminal PTY via IPC.
 * More reliable than keyboard typing when multiple terminals are active,
 * since page.keyboard.type() sends characters one-by-one through the
 * browser event loop and can drop keystrokes under load.
 */
async function setActive(page: import("@playwright/test").Page, panelId: string) {
  await page.evaluate((id) => {
    const w = window as unknown as {
      electron?: {
        terminal?: { setActivityTier?: (id: string, tier: "active" | "background") => void };
      };
    };
    w.electron?.terminal?.setActivityTier?.(id, "active");
  }, panelId);
}

async function ptyWrite(page: import("@playwright/test").Page, panelId: string, data: string) {
  const result = await page.evaluate(
    ([id, d]) => {
      const w = window as unknown as {
        electron?: { terminal?: { write?: (id: string, d: string) => void } };
      };
      if (!w.electron?.terminal?.write) {
        return { ok: false, reason: "terminal.write API missing" };
      }
      w.electron.terminal.write(id, d);
      return { ok: true };
    },
    [panelId, data]
  );
  if (!result.ok) throw new Error(`ptyWrite failed: ${result.reason}`);
}

async function ptySubmit(page: import("@playwright/test").Page, panelId: string, text: string) {
  const result = await page.evaluate(
    async ([id, t]) => {
      const w = window as unknown as {
        electron?: { terminal?: { submit?: (id: string, t: string) => Promise<unknown> } };
      };
      if (!w.electron?.terminal?.submit) {
        return { ok: false, reason: "terminal.submit API missing" };
      }
      try {
        // PTY submit writes body, then appends `\r` for each trailing newline.
        // Without a trailing `\n` the command text is written but never committed.
        const payload = t.endsWith("\n") ? t : `${t}\n`;
        await w.electron.terminal.submit(id, payload);
        return { ok: true };
      } catch (err) {
        // eslint-disable-next-line no-restricted-syntax -- runs inside page.evaluate, cannot import shared helpers.
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    [panelId, text]
  );
  if (!result.ok) throw new Error(`ptySubmit failed: ${result.reason}`);
}

test.describe.serial("Core: Terminal Isolation", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "terminal-isolation" });
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Terminal Isolation Test"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("flood one terminal while another remains responsive", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    // Open 3 terminals
    for (let i = 0; i < 3; i++) {
      await openTerminal(window);
      await window.waitForTimeout(T_SETTLE);
    }
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);

    // Identify panels
    const ids = await getGridPanelIds(window);
    expect(ids.length).toBe(3);
    floodPanelId = ids[0];
    probePanelId = ids[1];

    const floodPanel = getPanelById(window, floodPanelId);
    const probePanel = getPanelById(window, probePanelId);

    // Wait for shell readiness in both terminals
    await waitForTerminalText(floodPanel, "terminal-isolation", T_LONG);
    await waitForTerminalText(probePanel, "terminal-isolation", T_LONG);

    // Mark both terminals as active so neither is throttled by the
    // background activity tier (only one panel is typically visible/active).
    await setActive(window, floodPanelId);
    await setActive(window, probePanelId);

    // Start a moderate flood in the first terminal via PTY submit. The rate is
    // deliberately throttled to ensure isolation is measurable without
    // saturating the PTY host's write queue.
    await ptySubmit(window, floodPanelId, "while true; do echo FLOOD_LINE; sleep 0.1; done");
    await waitForTerminalText(floodPanel, "FLOOD_LINE", T_LONG);

    // Send probe command in the second terminal via PTY submit — keyboard.type
    // races with the flood's output and can interleave characters between panels.
    await ptySubmit(window, probePanelId, "echo RESPONSE_OK");
    await waitForTerminalText(probePanel, "RESPONSE_OK", T_LONG);

    // Verify toolbar remains interactive (app is not frozen)
    await expect(window.locator(SEL.toolbar.toggleSidebar)).toBeVisible();
  });

  test("flooded terminal recovers after stopping flood", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    const floodPanel = getPanelById(window, floodPanelId);

    // Send Ctrl+C (0x03) directly via PTY to interrupt the flood — keyboard
    // events can race with the flooded output.
    await ptyWrite(window, floodPanelId, "\x03");

    // Wait for shell to settle after interrupt
    await window.waitForTimeout(T_SETTLE);

    // Run recovery command in the previously flooded terminal
    await ptySubmit(window, floodPanelId, "echo FLOOD_RECOVERED");
    await waitForTerminalText(floodPanel, "FLOOD_RECOVERED", T_LONG);
  });
});
