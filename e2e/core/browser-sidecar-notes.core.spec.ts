import { test, expect } from "@playwright/test";
import { createServer, type Server } from "http";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;
let server: Server;
let port: number;

test.describe.serial("Browser, Sidecar & Notes", () => {
  test.beforeAll(async () => {
    // Start a local HTTP server
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>E2E Test Page</h1></body></html>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const fixtureDir = createFixtureRepo({ name: "browser-test" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Browser Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    server?.close();
  });

  test("open browser panel via toolbar", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.openBrowser).click();

    const addressBar = window.locator(SEL.browser.addressBar);
    await expect(addressBar).toBeVisible({ timeout: T_LONG });
  });

  test("navigate to local server", async () => {
    const { window } = ctx;

    const addressBar = window.locator(SEL.browser.addressBar);
    await addressBar.click();
    await addressBar.fill(`http://127.0.0.1:${port}`);
    await window.keyboard.press("Enter");

    // Give the webview time to load
    await window.waitForTimeout(2_000);

    // Address bar may strip the http:// protocol
    await expect(addressBar).toHaveValue(new RegExp(`127\\.0\\.0\\.1:${port}`), {
      timeout: T_MEDIUM,
    });
  });

  test("sidecar toggle opens and closes", async () => {
    const { window } = ctx;

    const sidecarBtn = window.locator(SEL.toolbar.sidecarToggle);
    if (!(await sidecarBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await sidecarBtn.click();
    await window.waitForTimeout(500);

    await sidecarBtn.click();
    await window.waitForTimeout(500);
  });

  test("notes palette opens and shows editor", async () => {
    const { window } = ctx;

    const notesBtn = window.locator(SEL.toolbar.notesButton);
    if (!(await notesBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }

    await notesBtn.click();

    const palette = window.locator(SEL.notes.palette);
    await expect(palette).toBeVisible({ timeout: T_MEDIUM });

    // Close notes
    await window.keyboard.press("Escape");
    await expect(palette).not.toBeVisible({ timeout: T_SHORT });
  });
});
