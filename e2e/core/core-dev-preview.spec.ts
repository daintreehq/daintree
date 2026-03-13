import { test, expect } from "@playwright/test";
import { createServer, type Server } from "http";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;
let server: Server;
let port: number;
const PROJECT_NAME = "Dev Preview Test";

test.describe.serial("Core: Dev Preview", () => {
  test.beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Dev Preview E2E</h1></body></html>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const repo = createFixtureRepo({ name: "dev-preview-test" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, repo, PROJECT_NAME);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    server?.close();
  });

  test.describe.serial("Panel Chrome", () => {
    test("opening dev preview panel adds to grid", async () => {
      const { window } = ctx;

      const devBtn = window.locator(SEL.toolbar.openDevPreview);
      if (!(await devBtn.isVisible().catch(() => false))) {
        test.skip();
        return;
      }

      const before = await getGridPanelCount(window);
      await devBtn.click();

      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
    });

    test("panel shows unconfigured state with visible address bar", async () => {
      const { window } = ctx;

      const addressBar = window.locator(SEL.browser.addressBar);
      await expect(addressBar).toBeVisible({ timeout: T_MEDIUM });

      const configureText = window.locator("text=Configure Dev Server");
      await expect(configureText).toBeVisible({ timeout: T_MEDIUM });
    });

    test("address bar navigation updates display URL", async () => {
      const { window } = ctx;

      const addressBar = window.locator(SEL.browser.addressBar);
      await addressBar.click();
      await addressBar.fill(`http://127.0.0.1:${port}`);
      await window.keyboard.press("Enter");

      await expect(addressBar).toHaveValue(new RegExp(`127\\.0\\.0\\.1:${port}`), {
        timeout: T_MEDIUM,
      });
    });

    test("zoom in increases zoom level", async () => {
      const { window } = ctx;

      const zoomIn = window.locator(SEL.browser.zoomIn);
      const zoomReset = window.locator(SEL.browser.zoomReset);

      await expect(zoomIn).toBeVisible({ timeout: T_SHORT });
      await zoomIn.click();

      await expect(zoomReset).toContainText("125%", { timeout: T_SHORT });
    });

    test("zoom in again steps to 150%", async () => {
      const { window } = ctx;

      const zoomIn = window.locator(SEL.browser.zoomIn);
      const zoomReset = window.locator(SEL.browser.zoomReset);

      await zoomIn.click();
      await expect(zoomReset).toContainText("150%", { timeout: T_SHORT });
    });

    test("zoom out steps back toward 100%", async () => {
      const { window } = ctx;

      const zoomOut = window.locator(SEL.browser.zoomOut);
      const zoomReset = window.locator(SEL.browser.zoomReset);

      await zoomOut.click();
      await expect(zoomReset).toContainText("125%", { timeout: T_SHORT });
    });

    test("zoom reset returns to 100%", async () => {
      const { window } = ctx;

      const zoomReset = window.locator(SEL.browser.zoomReset);
      await zoomReset.click();

      await expect(zoomReset).toContainText("100%", { timeout: T_SHORT });
    });

    test("console drawer toggle works when present", async () => {
      const { window } = ctx;

      const consoleToggle = window.locator(SEL.devPreview.consoleToggle).first();
      if (!(await consoleToggle.isVisible({ timeout: T_SHORT }).catch(() => false))) {
        test.skip();
        return;
      }

      await consoleToggle.click();
      await expect(window.locator('[aria-label="Hide Terminal"]')).toBeVisible({
        timeout: T_SHORT,
      });

      await window.locator('[aria-label="Hide Terminal"]').click();
      await expect(window.locator('[aria-label="Show Terminal"]')).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("closing dev preview panel removes it from grid", async () => {
      const { window } = ctx;

      const before = await getGridPanelCount(window);
      const panel = window.locator(SEL.panel.gridPanel).first();
      await panel.locator(SEL.panel.close).first().click({ force: true });

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before - 1);
    });
  });
});
