import { test, expect } from "@playwright/test";
import { createServer, type Server } from "http";
import { writeFileSync } from "fs";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let server: Server;
let port: number;
let fixtureRepoPath: string;
let fixtureCleanup: (() => void) | undefined;
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

    const { dir, cleanup } = createFixtureRepo({ name: "dev-preview-test" });
    fixtureRepoPath = dir;
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureRepoPath, PROJECT_NAME);

    // Fail fast if the dev preview entry point is missing — the button renders
    // for any onboarded project, so its absence is a real regression, not a
    // launch-state quirk to silently skip past.
    await expect(ctx.window.locator(SEL.toolbar.openDevPreview)).toBeVisible({ timeout: T_LONG });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    server?.close();
    fixtureCleanup?.();
  });

  test.describe.serial("Panel Chrome", () => {
    test("opening dev preview panel adds to grid", async () => {
      const { window } = ctx;

      const devBtn = window.locator(SEL.toolbar.openDevPreview);
      const before = await getGridPanelCount(window);
      await devBtn.click();

      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
    });

    test("panel shows unconfigured state with visible address bar", async () => {
      const { window } = ctx;

      await expect(window.locator(SEL.browser.addressBar)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.getByRole("heading", { name: "Set a dev command" })).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("address bar navigation updates display URL", async () => {
      const { window } = ctx;

      const addressBar = window.locator(SEL.browser.addressBar);
      await addressBar.click();
      await addressBar.fill(`http://127.0.0.1:${port}`);
      await window.keyboard.press("Enter");

      await expect
        .poll(() => addressBar.inputValue(), { timeout: T_MEDIUM })
        .toMatch(new RegExp(`127\\.0\\.0\\.1:${port}`));
    });

    test("zoom in increases zoom level", async () => {
      const { window } = ctx;

      const zoomIn = window.locator(SEL.browser.zoomIn);
      const zoomReset = window.locator(SEL.browser.zoomReset);

      await zoomIn.click();
      await expect(zoomReset).toContainText("125%", { timeout: T_MEDIUM });
    });

    test("zoom in again steps to 150%", async () => {
      const { window } = ctx;

      const zoomIn = window.locator(SEL.browser.zoomIn);
      const zoomReset = window.locator(SEL.browser.zoomReset);

      await zoomIn.click();
      await expect(zoomReset).toContainText("150%", { timeout: T_MEDIUM });
    });

    test("zoom out steps back toward 100%", async () => {
      const { window } = ctx;

      const zoomOut = window.locator(SEL.browser.zoomOut);
      const zoomReset = window.locator(SEL.browser.zoomReset);

      await zoomOut.click();
      await expect(zoomReset).toContainText("125%", { timeout: T_MEDIUM });
    });

    test("zoom reset returns to 100%", async () => {
      const { window } = ctx;

      const zoomReset = window.locator(SEL.browser.zoomReset);
      await zoomReset.click();

      await expect(zoomReset).toContainText("100%", { timeout: T_MEDIUM });
    });

    test("console drawer toggle is absent until a dev server starts", async () => {
      const { window } = ctx;

      // The ConsoleDrawer is gated on a live dev-server terminalId
      // (DevPreviewPane: `{consoleTerminalId && <ConsoleDrawer ... />}`), so in
      // this unconfigured panel — no dev command set, server never started — the
      // toggle must not render. Its expand/collapse behavior is exercised in the
      // Server Lifecycle block, where a server is actually running.
      const consoleToggle = window.locator(SEL.devPreview.consoleToggle).first();
      await expect(consoleToggle).toHaveCount(0);

      // Sanity-check we're in the unconfigured state the assertion above assumes.
      await expect(window.getByRole("heading", { name: "Set a dev command" })).toBeVisible({
        timeout: T_MEDIUM,
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

  test.describe.serial("Server Lifecycle", () => {
    test.beforeAll(async () => {
      const serverScript = `
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body><h1>Dev Preview E2E</h1></body></html>');
});
server.listen(0, '127.0.0.1', () => {
  console.log('http://localhost:' + server.address().port);
});
`;
      writeFileSync(path.join(fixtureRepoPath, "dev-server.cjs"), serverScript);
    });

    test("dev server starts and reaches Running status when devServerCommand is preset", async () => {
      const { window } = ctx;

      // Open dev preview panel
      const devBtn = window.locator(SEL.toolbar.openDevPreview);
      const before = await getGridPanelCount(window);
      await devBtn.click();
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);

      // Confirm unconfigured state
      await expect(window.getByRole("heading", { name: "Set a dev command" })).toBeVisible({
        timeout: T_MEDIUM,
      });

      // Set devServerCommand via IPC to avoid the unsaved-changes dialog.
      // Read current settings, merge the dev command, and save back.
      await window.evaluate(async () => {
        const current = await window.electron.project.getCurrent();
        if (!current?.id) return;
        const settings = await window.electron.project.getSettings(current.id);
        await window.electron.project.saveSettings(current.id, {
          ...settings,
          devServerCommand: "node dev-server.cjs",
        });
      });
      // Reload to ensure the renderer picks up the new settings
      await window.reload({ waitUntil: "domcontentloaded" });
      await window.locator(SEL.toolbar.toggleSidebar).waitFor({
        state: "visible",
        timeout: T_LONG,
      });

      // Wait for console drawer's status badge to show "Running".
      // Scope to the bar that contains the console toggle to avoid matching
      // other [role="status"] elements elsewhere in the page.
      const consoleBar = window.locator('[aria-controls^="console-drawer-"]').locator("..");
      const statusBadge = consoleBar.locator('[role="status"]');
      await expect(statusBadge).toContainText("Running", { timeout: T_LONG });

      // Verify address bar contains a localhost URL
      const addressBar = window.locator(SEL.browser.addressBar);
      await expect(addressBar).toHaveValue(/localhost:\d+/, { timeout: T_MEDIUM });

      // Verify webview element is rendered
      const webview = window.locator("webview");
      await expect(webview).toBeAttached({ timeout: T_MEDIUM });
    });

    test("console drawer shows server output", async () => {
      const { window } = ctx;

      // Open console drawer
      const consoleToggle = window.locator(SEL.devPreview.consoleToggle).first();
      await expect(consoleToggle).toBeVisible({ timeout: T_MEDIUM });
      await consoleToggle.click();

      await expect(consoleToggle).toHaveAttribute("aria-expanded", "true", {
        timeout: T_SHORT,
      });

      // Verify terminal buffer contains the localhost URL the server printed.
      // Extract terminalId from the console drawer's DOM id attribute. Wait for
      // the drawer to attach so the id is present before reading it — a null id
      // would silently poll an empty buffer until timeout with a confusing error.
      const drawerEl = window.locator('[id^="console-drawer-"]');
      await drawerEl.waitFor({ state: "attached", timeout: T_MEDIUM });
      const drawerId = await drawerEl.getAttribute("id");
      const terminalId = drawerId?.replace("console-drawer-", "") ?? "";
      expect(terminalId).not.toBe("");

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
          { timeout: T_LONG }
        )
        .toContain("localhost:");

      // Close the console drawer
      await consoleToggle.click();
      await expect(consoleToggle).toHaveAttribute("aria-expanded", "false", {
        timeout: T_SHORT,
      });
    });

    test("diagnostics tab shows the session timeline", async () => {
      const { window } = ctx;

      const consoleToggle = window.locator(SEL.devPreview.consoleToggle).first();
      await expect(consoleToggle).toBeVisible({ timeout: T_MEDIUM });
      await consoleToggle.click();
      await expect(consoleToggle).toHaveAttribute("aria-expanded", "true", {
        timeout: T_SHORT,
      });

      await window.getByRole("tab", { name: "Diagnostics" }).click();

      // Summary reflects the live session (running server from the prior test).
      const diagnosticsPanel = window.getByRole("tabpanel", { name: "Diagnostics" });
      await expect(diagnosticsPanel).toBeVisible({ timeout: T_MEDIUM });
      await expect(diagnosticsPanel).toContainText("Proxy upstream", { timeout: T_MEDIUM });

      // The bounded timeline recorded the real lifecycle: spawn and URL
      // detection came through the main-process ring, not renderer state.
      await expect(diagnosticsPanel).toContainText("Dev server spawned", { timeout: T_MEDIUM });
      await expect(diagnosticsPanel).toContainText("URL detected", { timeout: T_MEDIUM });

      // Close the console drawer
      await consoleToggle.click();
      await expect(consoleToggle).toHaveAttribute("aria-expanded", "false", {
        timeout: T_SHORT,
      });
    });

    test("closing dev preview panel after lifecycle test", async () => {
      const { window } = ctx;

      const before = await getGridPanelCount(window);
      expect(before).toBeGreaterThan(0);
      const panel = window.locator(SEL.panel.gridPanel).first();
      await panel.locator(SEL.panel.close).first().click({ force: true });

      await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(before - 1);
    });
  });
});
