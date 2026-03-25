import { test, expect } from "@playwright/test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount, openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_LONG, T_SETTLE } from "../helpers/timeouts";
import { runTerminalCommand, waitForTerminalText, triggerTerminalLink } from "../helpers/terminal";

let ctx: AppContext;
let server: Server;
let port: number;

function handleRequest(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body><h1>Link Test</h1></body></html>");
}

test.describe.serial("Core: Terminal Links", () => {
  test.beforeAll(async () => {
    server = createServer(handleRequest);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const fixture = createFixtureRepo({ name: "terminal-links-test" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixture, "Terminal Links Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    server?.close();
  });

  test("echo localhost URL appears in terminal buffer", async () => {
    const { window } = ctx;

    await openTerminal(window);
    const panel = window.locator(SEL.panel.gridPanel).first();
    await expect(panel).toBeVisible({ timeout: T_LONG });

    const url = `http://127.0.0.1:${port}/test-page`;
    await runTerminalCommand(window, panel, `node -e "console.log('${url}')"`);
    await waitForTerminalText(panel, url);
  });

  test("Cmd+click localhost URL opens browser panel", async () => {
    const { window } = ctx;

    const terminalPanel = window
      .locator(SEL.panel.gridPanel)
      .filter({ hasNot: window.locator(SEL.browser.addressBar) })
      .first();
    const url = `http://127.0.0.1:${port}/test-page`;

    const result = await triggerTerminalLink(terminalPanel, url);
    expect(result).toBe("ok");

    const browserPanel = window.locator(SEL.panel.gridPanel).filter({
      has: window.locator(SEL.browser.addressBar),
    });
    await expect(browserPanel).toBeVisible({ timeout: T_LONG });

    const addressBar = browserPanel.locator(SEL.browser.addressBar);
    await expect(addressBar).toHaveValue(/127\.0\.0\.1/, { timeout: T_LONG });
    await expect(addressBar).toHaveValue(/test-page/, { timeout: T_SHORT });
  });

  test("triggering same URL reuses existing browser panel", async () => {
    const { window } = ctx;

    const panelCountBefore = await getGridPanelCount(window);
    const terminalPanel = window
      .locator(SEL.panel.gridPanel)
      .filter({ hasNot: window.locator(SEL.browser.addressBar) })
      .first();
    const url = `http://127.0.0.1:${port}/test-page`;

    const result = await triggerTerminalLink(terminalPanel, url);
    expect(result).toBe("ok");

    await window.waitForTimeout(T_SETTLE);
    const panelCountAfter = await getGridPanelCount(window);
    expect(panelCountAfter).toBe(panelCountBefore);

    const addressBar = window
      .locator(SEL.panel.gridPanel)
      .filter({ has: window.locator(SEL.browser.addressBar) })
      .locator(SEL.browser.addressBar);
    await expect(addressBar).toHaveValue(/test-page/, { timeout: T_SHORT });
  });
});
