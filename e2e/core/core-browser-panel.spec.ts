import { test, expect } from "@playwright/test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let server: Server;
let port: number;

function handleRequest(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/html" });
  const url = _req.url ?? "/";
  if (url.startsWith("/page-a")) {
    res.end("<html><body><h1>Page A</h1></body></html>");
  } else if (url.startsWith("/page-b")) {
    res.end("<html><body><h1>Page B</h1></body></html>");
  } else {
    res.end("<html><body><h1>Home</h1></body></html>");
  }
}

test.describe.serial("Core: Browser Panel", () => {
  test.beforeAll(async () => {
    server = createServer(handleRequest);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const fixture = createFixtureRepo({ name: "browser-panel-test" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixture, "Browser Panel Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    server?.close();
  });

  test.describe.serial("Navigation and History", () => {
    test.afterAll(async () => {
      try {
        const { window } = ctx;
        let count = await getGridPanelCount(window);
        while (count > 0) {
          const panel = window.locator(SEL.panel.gridPanel).first();
          await panel.locator(SEL.panel.close).first().click({ force: true });
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
          count--;
        }
      } catch {
        // best-effort cleanup
      }
    });

    test("open browser panel shows address bar and nav controls", async () => {
      const { window } = ctx;

      await window.locator(SEL.toolbar.openBrowser).click();

      // Wait for browser panel to appear in the grid
      const browserPanel = window.locator(SEL.panel.gridPanel).filter({
        has: window.locator(SEL.browser.addressBar),
      });
      await expect(browserPanel).toBeVisible({ timeout: T_LONG });
      await expect(browserPanel.locator(SEL.browser.backButton)).toBeVisible({ timeout: T_SHORT });
      await expect(browserPanel.locator(SEL.browser.forwardButton)).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(browserPanel.locator(SEL.browser.reloadButton)).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("back and forward buttons disabled on fresh panel", async () => {
      const { window } = ctx;
      const panel = window.locator(SEL.panel.gridPanel).filter({
        has: window.locator(SEL.browser.addressBar),
      });

      await expect(panel.locator(SEL.browser.backButton)).toBeDisabled({ timeout: T_SHORT });
      await expect(panel.locator(SEL.browser.forwardButton)).toBeDisabled({ timeout: T_SHORT });
    });

    test("navigate to Page A via address bar", async () => {
      const { window } = ctx;
      const panel = window.locator(SEL.panel.gridPanel).filter({
        has: window.locator(SEL.browser.addressBar),
      });
      const addressBar = panel.locator(SEL.browser.addressBar);

      await addressBar.click();
      await addressBar.fill(`http://127.0.0.1:${port}/page-a`);
      await window.keyboard.press("Enter");
      await window.waitForTimeout(T_SETTLE);

      await expect(addressBar).toHaveValue(/page-a/, { timeout: T_LONG });
    });

    test("navigate to Page B updates address bar", async () => {
      const { window } = ctx;
      const panel = window.locator(SEL.panel.gridPanel).filter({
        has: window.locator(SEL.browser.addressBar),
      });
      const addressBar = panel.locator(SEL.browser.addressBar);

      await addressBar.click();
      await addressBar.fill(`http://127.0.0.1:${port}/page-b`);
      await window.keyboard.press("Enter");
      await window.waitForTimeout(T_SETTLE);

      await expect(addressBar).toHaveValue(/page-b/, { timeout: T_LONG });
      await expect(panel.locator(SEL.browser.backButton)).toBeEnabled({ timeout: T_SHORT });
    });

    test("back button returns to Page A", async () => {
      const { window } = ctx;
      const panel = window.locator(SEL.panel.gridPanel).filter({
        has: window.locator(SEL.browser.addressBar),
      });
      const addressBar = panel.locator(SEL.browser.addressBar);

      await panel.locator(SEL.browser.backButton).click();
      await window.waitForTimeout(T_SETTLE);

      await expect(addressBar).toHaveValue(/page-a/, { timeout: T_LONG });
      await expect(panel.locator(SEL.browser.forwardButton)).toBeEnabled({ timeout: T_SHORT });
    });

    test("forward button returns to Page B", async () => {
      const { window } = ctx;
      const panel = window.locator(SEL.panel.gridPanel).filter({
        has: window.locator(SEL.browser.addressBar),
      });
      const addressBar = panel.locator(SEL.browser.addressBar);

      await panel.locator(SEL.browser.forwardButton).click();
      await window.waitForTimeout(T_SETTLE);

      await expect(addressBar).toHaveValue(/page-b/, { timeout: T_LONG });
    });

    test("reload preserves current URL", async () => {
      const { window } = ctx;
      const panel = window.locator(SEL.panel.gridPanel).filter({
        has: window.locator(SEL.browser.addressBar),
      });
      const addressBar = panel.locator(SEL.browser.addressBar);

      const urlBefore = await addressBar.inputValue();
      await expect(panel.locator(SEL.browser.reloadButton)).toBeEnabled({ timeout: T_SHORT });
      await panel.locator(SEL.browser.reloadButton).click();
      await window.waitForTimeout(T_SETTLE);

      await expect(addressBar).toHaveValue(
        new RegExp(urlBefore.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        {
          timeout: T_LONG,
        }
      );
    });
  });

  test.describe.serial("Multi-panel Isolation", () => {
    test.afterAll(async () => {
      try {
        const { window } = ctx;
        let count = await getGridPanelCount(window);
        while (count > 0) {
          const panel = window.locator(SEL.panel.gridPanel).first();
          await panel.locator(SEL.panel.close).first().click({ force: true });
          await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
          count--;
        }
      } catch {
        // best-effort cleanup
      }
    });

    test("second browser panel has independent URL state", async () => {
      // Windows CI with GPU disabled cannot reliably create multiple BrowserViews;
      // the second webview panel never appears. macOS/Linux cover this scenario.
      test.skip(
        process.platform === "win32" && !!process.env.CI,
        "Windows CI: multiple browser panels not supported with GPU disabled"
      );
      const { window } = ctx;

      // Open first browser panel and navigate to page-a
      await window.locator(SEL.toolbar.openBrowser).click();
      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_LONG })
        .toBeGreaterThanOrEqual(1);

      const panel1 = window
        .locator(SEL.panel.gridPanel)
        .filter({
          has: window.locator(SEL.browser.addressBar),
        })
        .first();
      const addressBar1 = panel1.locator(SEL.browser.addressBar);

      await addressBar1.click();
      await addressBar1.fill(`http://127.0.0.1:${port}/page-a`);
      await window.keyboard.press("Enter");
      await window.waitForTimeout(T_SETTLE);
      await expect(addressBar1).toHaveValue(/page-a/, { timeout: T_LONG });

      // Open second browser panel
      await window.locator(SEL.toolbar.openBrowser).click();
      await window.waitForTimeout(T_SETTLE);

      const browserPanels = window.locator(SEL.panel.gridPanel).filter({
        has: window.locator(SEL.browser.addressBar),
      });
      await expect.poll(() => browserPanels.count(), { timeout: T_LONG }).toBeGreaterThanOrEqual(2);

      const panel2 = browserPanels.nth(1);
      const addressBar2 = panel2.locator(SEL.browser.addressBar);

      // Navigate second panel to page-b
      await addressBar2.click();
      await addressBar2.fill(`http://127.0.0.1:${port}/page-b`);
      await window.keyboard.press("Enter");
      await window.waitForTimeout(T_SETTLE);

      // Assert isolation: panel 1 still shows page-a, panel 2 shows page-b
      await expect(addressBar2).toHaveValue(/page-b/, { timeout: T_LONG });
      await expect(addressBar1).toHaveValue(/page-a/, { timeout: T_SHORT });
    });
  });

  test.describe.serial("Panel Close", () => {
    test("closing browser panel removes it from grid", async () => {
      const { window } = ctx;

      // Open a browser panel if none exist
      const initialCount = await getGridPanelCount(window);
      if (initialCount === 0) {
        await window.locator(SEL.toolbar.openBrowser).click();
        await expect
          .poll(() => getGridPanelCount(window), { timeout: T_LONG })
          .toBeGreaterThanOrEqual(1);
      }

      const count = await getGridPanelCount(window);
      const panel = window.locator(SEL.panel.gridPanel).first();
      await panel.locator(SEL.panel.close).first().click({ force: true });

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(count - 1);
    });
  });
});
