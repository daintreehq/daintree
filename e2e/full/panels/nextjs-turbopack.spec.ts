import { test, expect } from "@playwright/test";
import { writeFileSync, mkdirSync } from "fs";
import { createServer } from "http";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { saveCurrentProjectSettings } from "../../helpers/projectSettings";
import { SEL } from "../../helpers/selectors";
import { T_SHORT } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureRepoPath: string;
let devServerPort: number;
let fixtureCleanup: (() => void) | undefined;
const PROJECT_NAME = "Next.js Turbopack Test";
const DEV_SERVER_TIMEOUT = process.env.CI ? 60_000 : 30_000;

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
    const portProbe = createServer();
    await new Promise<void>((resolve, reject) => {
      portProbe.once("error", reject);
      portProbe.listen(0, "127.0.0.1", resolve);
    });
    const probeAddress = portProbe.address();
    devServerPort = typeof probeAddress === "object" && probeAddress ? probeAddress.port : 0;
    await new Promise<void>((resolve, reject) => {
      portProbe.close((error) => (error ? reject(error) : resolve()));
    });

    ({ dir: fixtureRepoPath, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "nextjs-turbopack",
    }));

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

    // Create a fake Next.js launcher that:
    // 1. Prints the received arguments (for verification)
    // 2. Starts a minimal HTTP server with inline CSS (for webview rendering test)
    // resolveNextMajorVersion reads node_modules/next/package.json first — the
    // auto-turbopack path only triggers when next's major version is >= 15.
    // Drop a stub package.json there so the fixture reports a compatible major.
    const nextDir = path.join(fixtureRepoPath, "node_modules", "next");
    mkdirSync(nextDir, { recursive: true });
    writeFileSync(
      path.join(nextDir, "package.json"),
      JSON.stringify({ name: "next", version: "15.0.0" }, null, 2)
    );

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
server.listen(${devServerPort}, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('ready - started server on 0.0.0.0:' + port + ', url: http://localhost:' + port);
});
`;
    writeFileSync(path.join(fixtureRepoPath, "fake-next.cjs"), fakeNextScript);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureRepoPath, PROJECT_NAME);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("auto-injects --turbopack and webview renders styled content", async () => {
    const { window } = ctx;

    // Configure dev server command, then open dev preview via action dispatch
    await saveCurrentProjectSettings(window, {
      devServerCommand: `node fake-next.cjs next dev --port ${devServerPort}`,
    });

    // Open dev preview panel via the exposed E2E action dispatcher
    await window.evaluate(async () => {
      const dispatch = (window as unknown as Record<string, (...args: unknown[]) => unknown>)
        .__daintreeDispatchAction;
      if (typeof dispatch !== "function") {
        throw new Error("Action dispatch hook not available");
      }
      await dispatch("devServer.start", undefined, { source: "user" });
    });

    // Wait for Running status
    const consoleBar = window.locator('[aria-controls^="console-drawer-"]').locator("..");
    const statusBadge = consoleBar.locator('[role="status"]');
    await expect(statusBadge).toContainText(/Running|Error/, { timeout: DEV_SERVER_TIMEOUT });
    const startupStatus = await statusBadge.textContent();
    if (startupStatus?.includes("Error")) {
      const drawerId = await window.locator('[id^="console-drawer-"]').first().getAttribute("id");
      const terminalId = drawerId?.replace("console-drawer-", "") ?? "";
      const terminalBuffer = await window.evaluate((id) => {
        const reader = (window as unknown as Record<string, unknown>).__daintreeReadTerminalBuffer;
        return typeof reader === "function" ? (reader(id) as string) : "";
      }, terminalId);
      throw new Error(`Dev server failed to start:\n${terminalBuffer}`);
    }

    // Verify address bar contains a localhost URL
    const addressBar = window.locator(SEL.browser.addressBar);
    await expect(addressBar).toHaveValue(/localhost:\d+/, { timeout: DEV_SERVER_TIMEOUT });

    // --- Verify --turbopack was injected ---

    const consoleToggle = window.locator(SEL.devPreview.consoleToggle).first();
    await expect(consoleToggle).toBeVisible({ timeout: T_SHORT });
    await consoleToggle.click();
    await expect(consoleToggle).toHaveAttribute("aria-expanded", "true", {
      timeout: T_SHORT,
    });

    const drawerEl = window.locator('[id^="console-drawer-"]').first();
    const drawerId = await drawerEl.getAttribute("id");
    const terminalId = drawerId?.replace("console-drawer-", "") ?? "";

    await expect
      .poll(
        async () => {
          return window.evaluate((id) => {
            const reader = (window as unknown as Record<string, unknown>)
              .__daintreeReadTerminalBuffer;
            if (typeof reader === "function") return reader(id) as string;
            return "";
          }, terminalId);
        },
        { timeout: DEV_SERVER_TIMEOUT }
      )
      .toContain("--turbopack");

    await consoleToggle.click();

    // --- Verify webview renders styled content ---

    const webview = window.locator("webview");
    await expect(webview).toBeAttached({ timeout: DEV_SERVER_TIMEOUT });

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
        { timeout: DEV_SERVER_TIMEOUT }
      )
      .toBe("rgb(30, 60, 120)");
  });
});
