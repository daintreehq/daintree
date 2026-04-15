import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync, chmodSync } from "fs";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureRepoPath: string;
const PROJECT_NAME = "Next.js Turbopack Test";

/**
 * E2E test for issue #4557: Next.js dev server CSS rendering in Daintree's webview.
 *
 * Creates a fixture repo that mimics a Next.js project (package.json with
 * "dev": "next dev") and a fake `next` binary that:
 *   - Echoes the received flags (so we can verify --turbopack was injected)
 *   - Starts a styled HTTP server (so we can verify CSS renders in the webview)
 *
 * Validates:
 *   1. The DevPreviewSessionService normalizes the command to include --turbopack
 *   2. The webview renders styled content from the dev server
 */
test.describe("Next.js Turbopack Normalization (#4557)", () => {
  test.beforeAll(async () => {
    fixtureRepoPath = createFixtureRepo({ name: "nextjs-turbopack" });

    // Create package.json with a Next.js dev script
    writeFileSync(
      path.join(fixtureRepoPath, "package.json"),
      JSON.stringify(
        {
          name: "nextjs-turbopack-test",
          version: "1.0.0",
          private: true,
          scripts: {
            dev: "next dev",
          },
        },
        null,
        2
      )
    );

    // Create a fake `next` binary in node_modules/.bin/ that:
    // 1. Prints the received arguments (for verification)
    // 2. Starts a minimal HTTP server with inline CSS (for webview rendering test)
    const binDir = path.join(fixtureRepoPath, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });

    const fakeNextScript = `#!/usr/bin/env node
const http = require('http');
const args = process.argv.slice(2);
console.log('NEXT_ARGS: ' + JSON.stringify(args));

const html = \`<!DOCTYPE html>
<html>
<head>
  <style>
    body { background-color: rgb(30, 60, 120); color: white; font-family: sans-serif; }
    h1 { font-size: 24px; }
    #status { color: rgb(0, 255, 100); }
  </style>
</head>
<body>
  <h1>Next.js Turbopack Test</h1>
  <p id="status">CSS is working</p>
</body>
</html>\`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('ready - started server on 0.0.0.0:' + port + ', url: http://localhost:' + port);
});
`;
    writeFileSync(path.join(binDir, "next"), fakeNextScript);
    chmodSync(path.join(binDir, "next"), 0o755);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureRepoPath, PROJECT_NAME);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("auto-injects --turbopack and webview renders styled content", async () => {
    const { window } = ctx;

    // Configure dev server command, then open dev preview via action dispatch
    await window.evaluate(async () => {
      const current = await window.electron.project.getCurrent();
      if (!current?.id) return;
      const settings = await window.electron.project.getSettings(current.id);
      await window.electron.project.saveSettings(current.id, {
        ...settings,
        devServerCommand: "npm run dev",
      });
    });

    // Open dev preview panel via the exposed E2E action dispatcher
    await window.evaluate(async () => {
      const dispatch = (window as unknown as Record<string, (...args: unknown[]) => unknown>)
        .__canopyDispatchAction;
      if (typeof dispatch === "function") {
        await dispatch("devServer.start", undefined, { source: "user" });
      }
    });

    // Wait for Running status
    const consoleBar = window.locator('[aria-controls^="console-drawer-"]').locator("..");
    const statusBadge = consoleBar.locator('[role="status"]');
    await expect(statusBadge).toContainText("Running", { timeout: T_LONG });

    // Verify address bar contains a localhost URL
    const addressBar = window.locator(SEL.browser.addressBar);
    await expect(addressBar).toHaveValue(/localhost:\d+/, { timeout: T_LONG });

    // --- Verify --turbopack was injected ---

    const consoleToggle = window.locator('[aria-label="Show Terminal"]').first();
    if (await consoleToggle.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      await consoleToggle.click();
      await expect(window.locator('[aria-label="Hide Terminal"]')).toBeVisible({
        timeout: T_SHORT,
      });

      const drawerEl = window.locator('[id^="console-drawer-"]');
      const drawerId = await drawerEl.getAttribute("id");
      const terminalId = drawerId?.replace("console-drawer-", "") ?? "";

      await expect
        .poll(
          async () => {
            return window.evaluate((id) => {
              const reader = (window as unknown as Record<string, unknown>)
                .__canopyReadTerminalBuffer;
              if (typeof reader === "function") return reader(id) as string;
              return "";
            }, terminalId);
          },
          { timeout: T_LONG }
        )
        .toContain("--turbopack");

      await window.locator('[aria-label="Hide Terminal"]').click();
    }

    // --- Verify webview renders styled content ---

    const webview = window.locator("webview");
    await expect(webview).toBeAttached({ timeout: T_LONG });

    // Check that CSS background-color is applied in the webview.
    await expect
      .poll(
        async () => {
          try {
            return await window.evaluate(async () => {
              const wv = document.querySelector("webview") as Electron.WebviewTag | null;
              if (!wv) return null;
              try {
                return await wv.executeJavaScript(
                  "window.getComputedStyle(document.body).backgroundColor"
                );
              } catch {
                return null;
              }
            });
          } catch {
            return null;
          }
        },
        { timeout: T_LONG }
      )
      .toBe("rgb(30, 60, 120)");
  });
});
