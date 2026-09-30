/**
 * Dev preview panels, one launch on a repo with a feature worktree:
 *   - Panel chrome in the unconfigured state (address-bar routing, zoom).
 *   - A configured dev server: Running, guest content, Output drawer,
 *     Diagnostics timeline, guest console capture, promote to portal.
 *   - Next.js `next dev` gets `--turbopack` injected and its styles paint.
 *   - Per-worktree sessions: main and feature panels run side by side on
 *     different origins, and closing one leaves the other running.
 *
 * `devServerCommand` is saved before a panel opens so the panel auto-starts
 * without a renderer reload.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import { createServer, type Server } from "http";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { buildDevPreviewProxyOrigin } from "../../../shared/utils/devPreviewProxy";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  clickToolbarButton,
  expectToolbarButtonReachable,
  getGridPanelCount,
  getGridPanelIds,
  openDevPreview,
} from "../../helpers/panels";
import { saveCurrentProjectSettings } from "../../helpers/projectSettings";
import { switchWorktree } from "../../helpers/workflows";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

const PROJECT_NAME = "Dev Preview Test";
const FEATURE_BRANCH = "feature/test-branch";
const DEV_SERVER_COMMAND = "node dev-server.cjs";
const CAPTURE_MARKER = "e2e-console-capture-error";
const COOKIE_NAME = "dt_promote_e2e";
const COOKIE_VALUE = "carried-over";
const GUEST_BACKGROUND = "rgb(30, 60, 120)";
const DEV_PREVIEW_ADDRESS_BAR_RE = /^(?:https?:\/\/)?(?:localhost|dp-[a-z0-9-]+\.localhost):\d+$/;
const DEV_PREVIEW_PROXY_HOST_RE = /^(?:localhost|dp-[a-z0-9-]+\.localhost)$/;
const DEV_SERVER_TIMEOUT = process.env.CI ? 60_000 : 30_000;

// Binds PORT when the session injects one, prints the URL the session watches
// for, and serves a styled page that logs console errors on load and for a
// bounded while afterwards, so capture can attach without host-side script
// injection.
const DEV_SERVER_SCRIPT = `
const http = require('http');
const port = parseInt(process.env.PORT || '0', 10);
const html = '<html><head><title>Dev Preview E2E</title><style>body { background-color: ${GUEST_BACKGROUND}; }</style></head>'
  + '<body><h1>Dev Preview E2E</h1><script>console.error("${CAPTURE_MARKER}-initial");'
  + 'let count=0;const timer=setInterval(()=>{console.error("${CAPTURE_MARKER}-runtime");count+=1;if(count>=40)clearInterval(timer);},500);'
  + '</script></body></html>';
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});
server.listen(port, '127.0.0.1', () => {
  console.log('http://localhost:' + server.address().port);
});
`;

function fakeNextScript(port: number): string {
  return `#!/usr/bin/env node
const http = require('http');
console.log('NEXT_ARGS: ' + JSON.stringify(process.argv.slice(2)));
const html = '<!DOCTYPE html><html><head><style>'
  + 'body { background-color: ${GUEST_BACKGROUND}; color: white; } #status { color: rgb(0, 255, 100); }'
  + '</style></head><body><h1>Next.js Turbopack Test</h1><p id="status">CSS is working</p></body></html>';
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});
server.listen(${port}, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('ready - started server on 0.0.0.0:' + port + ', url: http://localhost:' + port);
});
`;
}

let ctx: AppContext;
let routeServer: Server;
let routeServerPort: number;
let nextPort: number;
let fixtureRepoPath: string;
let fixtureCleanup: (() => void) | undefined;

let urlMain = "";
let upstreamUrlMain = "";
let mainWorktreeId = "";
let featureWorktreeId = "";
let featurePanelId = "";

async function listenOnFreePort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

function parseDisplayOrigin(displayUrl: string): string {
  const parsed = new URL(displayUrl.includes("://") ? displayUrl : `http://${displayUrl}`);
  expect(parsed.protocol).toBe("http:");
  expect(parsed.hostname).toMatch(DEV_PREVIEW_PROXY_HOST_RE);
  expect(parsed.port).toMatch(/^\d+$/);
  return parsed.origin;
}

async function waitForGuestOrigin(webview: Locator): Promise<string> {
  let guestUrl = "";
  await expect
    .poll(
      async () => {
        guestUrl = await webview.evaluate((wv) => (wv as Electron.WebviewTag).getURL());
        return guestUrl;
      },
      { timeout: T_LONG }
    )
    .toMatch(/^http:\/\/(?:localhost|dp-[a-z0-9-]+\.localhost):\d+/);
  return parseDisplayOrigin(guestUrl);
}

function parseUpstreamOrigin(predictedUrl: string | null | undefined): string {
  expect(predictedUrl).toBeTruthy();
  const parsed = new URL(predictedUrl ?? "");
  expect(parsed.protocol).toBe("http:");
  expect(parsed.hostname).toBe("localhost");
  expect(parsed.port).toMatch(/^\d+$/);
  return parsed.origin;
}

/**
 * Evaluate in a live dev-preview guest from main. The host renderer's Trusted
 * Types policy can reject `webview.executeJavaScript`, main's cannot.
 */
async function evaluateInGuest(expression: string): Promise<unknown> {
  return ctx.app.evaluate(async ({ webContents }, source) => {
    for (const guest of webContents.getAllWebContents()) {
      if (guest.isDestroyed() || guest.getType() !== "webview") continue;
      const value = await guest.executeJavaScript(source).catch(() => null);
      if (value !== null && value !== undefined) return value;
    }
    return null;
  }, expression);
}

async function readTerminalBuffer(window: Page, terminalId: string): Promise<string> {
  return window.evaluate((id) => {
    const reader = (window as unknown as Record<string, unknown>).__daintreeReadTerminalBuffer;
    return typeof reader === "function" ? (reader(id) as string) : "";
  }, terminalId);
}

async function getWorktreeSession(window: Page, worktreeId: string) {
  return window.evaluate(
    (id: string) => globalThis.window.electron.devPreview.getByWorktree({ worktreeId: id }),
    worktreeId
  );
}

test.describe.serial("Core: Dev Preview", () => {
  test.beforeAll(async () => {
    routeServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Dev Preview E2E</h1></body></html>");
    });
    routeServerPort = await listenOnFreePort(routeServer);

    const portProbe = createServer();
    nextPort = await listenOnFreePort(portProbe);
    await new Promise<void>((resolve, reject) =>
      portProbe.close((error) => (error ? reject(error) : resolve()))
    );

    const { dir, cleanup } = createFixtureRepo({
      name: "dev-preview-test",
      withFeatureBranch: true,
    });
    fixtureRepoPath = dir;
    fixtureCleanup = cleanup;
    const featureWorktreeDir = path.join(
      path.dirname(dir),
      path.basename(dir) + "-worktrees",
      "feature-test-branch"
    );

    // Both tree roots carry the script so `node dev-server.cjs` works whichever
    // worktree the panel's cwd points to.
    writeFileSync(path.join(dir, "dev-server.cjs"), DEV_SERVER_SCRIPT);
    writeFileSync(path.join(featureWorktreeDir, "dev-server.cjs"), DEV_SERVER_SCRIPT);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureRepoPath, PROJECT_NAME);

    // Fail fast if the dev preview entry point is missing — it is reachable for
    // any onboarded project, so its absence is a real regression, not a
    // launch-state quirk to silently skip past. Reachability rather than direct
    // visibility since #11667: `dev-server` is no longer a default toolbar
    // button, so on a fresh profile it lives in the panel tray.
    await expectToolbarButtonReachable(ctx.window, SEL.toolbar.openDevPreview, T_LONG);

    const page = ctx.window;
    await expect
      .poll(
        async () => {
          const worktrees = await page.evaluate(() => window.electron.worktree.getAll());
          const mainWt = worktrees.find((w: { isMainWorktree?: boolean }) => w.isMainWorktree);
          const featureWt = worktrees.find((w: { branch?: string }) => w.branch === FEATURE_BRANCH);
          mainWorktreeId = mainWt?.id ?? "";
          featureWorktreeId = featureWt?.id ?? "";
          return Boolean(mainWorktreeId && featureWorktreeId);
        },
        { timeout: T_LONG }
      )
      .toBe(true);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    routeServer?.close();
    fixtureCleanup?.();
  });

  test.describe.serial("Panel Chrome", () => {
    test("opening dev preview panel adds to grid", async () => {
      const { window } = ctx;

      const before = await getGridPanelCount(window);
      await openDevPreview(window);

      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);
    });

    test("panel shows unconfigured state with visible address bar", async () => {
      const { window } = ctx;

      await expect(window.locator(SEL.browser.addressBar)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.getByText("Set a dev command", { exact: true })).toBeVisible({
        timeout: T_MEDIUM,
      });
    });

    test("address bar navigation preserves the route on the panel proxy origin", async () => {
      const { window } = ctx;

      const addressBar = window.locator(SEL.browser.addressBar);
      const panelId = await addressBar.evaluate((element) =>
        element.closest("[data-panel-id]")?.getAttribute("data-panel-id")
      );
      const { project, proxyPort } = await window.evaluate(async () => ({
        project: await globalThis.window.electron.project.getCurrent(),
        proxyPort: (await globalThis.window.electron.devPreview.getProxyPort()).port,
      }));
      expect(panelId).toBeTruthy();
      expect(project).toBeTruthy();
      const proxyOrigin = buildDevPreviewProxyOrigin(proxyPort, project!.id, panelId!);
      const route = "/preview/nested?mode=e2e#details";

      await addressBar.click();
      await addressBar.fill(`http://127.0.0.1:${routeServerPort}${route}`);
      await window.keyboard.press("Enter");

      await expect(addressBar).toHaveValue(`${new URL(proxyOrigin).host}${route}`, {
        timeout: T_MEDIUM,
      });
    });

    // Zoom lives in the More menu at 100% and in the address bar's zoom chip once
    // it has changed; the chip is the only on-toolbar sign of a non-default zoom.
    test("zoom in increases zoom level", async () => {
      const { window } = ctx;

      await window.locator(SEL.browser.moreActions).click();
      await window.getByRole("menuitem", { name: "Zoom in" }).click();
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.browser.zoomIndicator)).toContainText("125%", {
        timeout: T_MEDIUM,
      });
    });

    test("zoom in again steps to 150%", async () => {
      const { window } = ctx;

      await window.locator(SEL.browser.zoomIndicator).click();
      await window.locator(SEL.browser.zoomIn).click();
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.browser.zoomIndicator)).toContainText("150%", {
        timeout: T_MEDIUM,
      });
    });

    test("zoom out steps back toward 100%", async () => {
      const { window } = ctx;

      await window.locator(SEL.browser.zoomIndicator).click();
      await window.locator(SEL.browser.zoomOut).click();
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.browser.zoomIndicator)).toContainText("125%", {
        timeout: T_MEDIUM,
      });
    });

    test("zoom reset returns to 100%", async () => {
      const { window } = ctx;

      await window.locator(SEL.browser.zoomIndicator).click();
      await window.locator(SEL.browser.zoomReset).click();

      // The chip stays while its popover is open, so the controls do not vanish
      // under the pointer at 100%; closing it is what takes the chip away.
      await expect(window.locator(SEL.browser.zoomIndicator)).toContainText("100%", {
        timeout: T_MEDIUM,
      });
      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.browser.zoomIndicator)).toHaveCount(0, {
        timeout: T_MEDIUM,
      });
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
      await expect(window.getByText("Set a dev command", { exact: true })).toBeVisible({
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
      await saveCurrentProjectSettings(ctx.window, { devServerCommand: DEV_SERVER_COMMAND });
    });

    test("dev server starts and reaches Running status when devServerCommand is preset", async () => {
      const { window } = ctx;

      await expect(window.locator(SEL.worktree.mainRow)).toHaveAttribute("aria-current", "true", {
        timeout: T_LONG,
      });

      const before = await getGridPanelCount(window);
      await openDevPreview(window);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);

      // Scope to the bar that contains the console toggle to avoid matching
      // other [role="status"] elements elsewhere in the page.
      const consoleBar = window.locator('[aria-controls^="console-drawer-"]').locator("..");
      const statusBadge = consoleBar.locator('[role="status"]');
      await expect(statusBadge).toContainText("Running", { timeout: T_LONG });

      const addressBar = window.locator(SEL.browser.addressBar);
      await expect(addressBar).toHaveValue(/localhost:\d+/, { timeout: T_MEDIUM });
      await expect(addressBar).toHaveValue(DEV_PREVIEW_ADDRESS_BAR_RE, { timeout: T_MEDIUM });

      const webview = window.locator("webview");
      await expect(webview).toBeAttached({ timeout: T_MEDIUM });
    });

    test("guest renders the dev server's page and styles", async () => {
      await expect
        .poll(() => evaluateInGuest("document.querySelector('h1')?.textContent ?? null"), {
          timeout: T_LONG,
        })
        .toBe("Dev Preview E2E");
      await expect
        .poll(() => evaluateInGuest("window.getComputedStyle(document.body).backgroundColor"), {
          timeout: T_LONG,
        })
        .toBe(GUEST_BACKGROUND);
    });

    test("console drawer shows server output", async () => {
      const { window } = ctx;

      const consoleToggle = window.locator(SEL.devPreview.consoleToggle).first();
      await expect(consoleToggle).toBeVisible({ timeout: T_MEDIUM });
      await consoleToggle.click();

      await expect(consoleToggle).toHaveAttribute("aria-expanded", "true", {
        timeout: T_SHORT,
      });

      // Wait for the drawer to attach so the id is present before reading it — a
      // null id would silently poll an empty buffer until timeout with a
      // confusing error.
      const drawerEl = window.locator('[id^="console-drawer-"]');
      await drawerEl.waitFor({ state: "attached", timeout: T_MEDIUM });
      const drawerId = await drawerEl.getAttribute("id");
      const terminalId = drawerId?.replace("console-drawer-", "") ?? "";
      expect(terminalId).not.toBe("");

      await expect
        .poll(() => readTerminalBuffer(window, terminalId), { timeout: T_LONG })
        .toContain("localhost:");

      // Opening animates the drawer height and moves the toggle. The terminal
      // buffer can already be populated before that transition finishes.
      await expect
        .poll(
          () =>
            drawerEl.evaluate((drawer) =>
              drawer.getAnimations().every((animation) => animation.playState === "finished")
            ),
          { timeout: T_SHORT }
        )
        .toBe(true);

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

      const diagnosticsPanel = window.getByRole("tabpanel", { name: "Diagnostics" });
      await expect(diagnosticsPanel).toBeVisible({ timeout: T_MEDIUM });
      await expect(diagnosticsPanel).toContainText("Proxy upstream", { timeout: T_MEDIUM });

      // The bounded timeline recorded the real lifecycle: spawn and URL
      // detection came through the main-process ring, not renderer state.
      await expect(diagnosticsPanel).toContainText("Dev server spawned", { timeout: T_MEDIUM });
      await expect(diagnosticsPanel).toContainText("URL detected", { timeout: T_MEDIUM });

      await consoleToggle.click();
      await expect(consoleToggle).toHaveAttribute("aria-expanded", "false", {
        timeout: T_SHORT,
      });
    });

    test("captures guest console errors into the Console tab", async () => {
      const { window } = ctx;

      const consoleToggle = window.locator(SEL.devPreview.consoleToggle).first();
      await consoleToggle.click();
      await expect(consoleToggle).toHaveAttribute("aria-expanded", "true", {
        timeout: T_SHORT,
      });
      const consoleTab = window.locator(SEL.devPreview.consoleTab);
      const outputTab = window.locator(SEL.devPreview.outputTab);
      await expect(consoleTab).toBeVisible({ timeout: T_SHORT });
      await outputTab.focus();
      await window.keyboard.press("ArrowRight");
      await expect(consoleTab).toHaveAttribute("aria-selected", "true", {
        timeout: T_SHORT,
      });

      // The list is virtualized and multi-line rows (Electron's CSP warning) render
      // in full, so filter to the marker rather than relying on them landing inside
      // the viewport.
      await window
        .getByRole("searchbox", { name: "Filter console messages" })
        .or(window.getByLabel("Filter console messages"))
        .first()
        .fill(`${CAPTURE_MARKER}-runtime`);
      await expect(window.locator(`text=${CAPTURE_MARKER}-runtime`).first()).toBeVisible({
        timeout: T_LONG,
      });

      // The Console tab carries an error-count badge once errors land.
      await expect
        .poll(
          async () => {
            const text = (await consoleTab.textContent()) ?? "";
            const match = text.match(/\d+/);
            return match ? Number(match[0]) : 0;
          },
          { timeout: T_LONG }
        )
        .toBeGreaterThanOrEqual(1);

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

  // #4557: a `next dev` command gets --turbopack injected and the guest applies
  // the page's styles.
  test.describe.serial("Next.js Turbopack Normalization", () => {
    test.beforeAll(async () => {
      // Written only now: a package.json `dev` script is detected as a dev
      // command, which would replace the unconfigured state the chrome tests
      // need. Auto-turbopack only triggers when node_modules/next reports
      // major >= 15.
      writeFileSync(
        path.join(fixtureRepoPath, "package.json"),
        JSON.stringify({ name: "dev-preview-test", private: true, scripts: { dev: "next dev" } })
      );
      const nextDir = path.join(fixtureRepoPath, "node_modules", "next");
      mkdirSync(nextDir, { recursive: true });
      writeFileSync(path.join(nextDir, "package.json"), JSON.stringify({ version: "15.0.0" }));
      writeFileSync(path.join(fixtureRepoPath, "fake-next.cjs"), fakeNextScript(nextPort));

      await saveCurrentProjectSettings(ctx.window, {
        devServerCommand: `node fake-next.cjs next dev --port ${nextPort}`,
      });
    });

    test.afterAll(async () => {
      await saveCurrentProjectSettings(ctx.window, { devServerCommand: DEV_SERVER_COMMAND });
    });

    test("auto-injects --turbopack and webview renders styled content", async () => {
      const { window } = ctx;

      const idsBefore = await getGridPanelIds(window);
      await openDevPreview(window);
      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_LONG })
        .toBe(idsBefore.length + 1);
      const panelId = (await getGridPanelIds(window)).find((id) => !idsBefore.includes(id));
      expect(panelId).toBeTruthy();
      const panel = window.locator(`[data-panel-id="${panelId}"]`);

      const consoleBar = panel.locator('[aria-controls^="console-drawer-"]').locator("..");
      const statusBadge = consoleBar.locator('[role="status"]');
      await expect(statusBadge).toContainText(/Running|Error/, { timeout: DEV_SERVER_TIMEOUT });
      const startupStatus = await statusBadge.textContent();
      if (startupStatus?.includes("Error")) {
        const drawerId = await panel.locator('[id^="console-drawer-"]').first().getAttribute("id");
        const buffer = await readTerminalBuffer(
          window,
          drawerId?.replace("console-drawer-", "") ?? ""
        );
        throw new Error(`Dev server failed to start:\n${buffer}`);
      }

      await expect(panel.locator(SEL.browser.addressBar)).toHaveValue(/localhost:\d+/, {
        timeout: DEV_SERVER_TIMEOUT,
      });

      const consoleToggle = panel.locator(SEL.devPreview.consoleToggle).first();
      await expect(consoleToggle).toBeVisible({ timeout: T_SHORT });
      await consoleToggle.click();
      await expect(consoleToggle).toHaveAttribute("aria-expanded", "true", {
        timeout: T_SHORT,
      });

      const drawerEl = panel.locator('[id^="console-drawer-"]').first();
      await drawerEl.waitFor({ state: "attached", timeout: T_MEDIUM });
      const terminalId = (await drawerEl.getAttribute("id"))?.replace("console-drawer-", "") ?? "";
      expect(terminalId).not.toBe("");
      await expect
        .poll(() => readTerminalBuffer(window, terminalId), { timeout: DEV_SERVER_TIMEOUT })
        .toContain("--turbopack");

      await consoleToggle.click();

      await expect(panel.locator("webview")).toBeAttached({ timeout: DEV_SERVER_TIMEOUT });
      await expect
        .poll(() => evaluateInGuest("window.getComputedStyle(document.body).backgroundColor"), {
          timeout: DEV_SERVER_TIMEOUT,
        })
        .toBe(GUEST_BACKGROUND);

      await panel.locator(SEL.panel.close).first().click({ force: true });
      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_MEDIUM })
        .toBe(idsBefore.length);
    });
  });

  test.describe.serial("Per-Worktree Port Registry", () => {
    test("main-worktree panel reaches Running and shows a predictedUrl", async () => {
      const { window } = ctx;

      const mainRow = window.locator(SEL.worktree.mainRow);
      await expect(mainRow).toHaveAttribute("aria-current", "true", { timeout: T_LONG });

      const countBefore = await getGridPanelCount(window);
      await clickToolbarButton(window, SEL.toolbar.openDevPreview, T_MEDIUM);
      await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(countBefore + 1);

      const consoleBar = window.locator('[aria-controls^="console-drawer-"]').locator("..").first();
      const statusBadge = consoleBar.locator('[role="status"]');
      await expect(statusBadge).toContainText("Running", { timeout: T_LONG });

      // The address bar shows the dev server's own host-port; the stable origin
      // under comparison is the one the guest actually loaded.
      const addressBar = window.locator(SEL.browser.addressBar).first();
      await expect(addressBar).toHaveValue(DEV_PREVIEW_ADDRESS_BAR_RE, { timeout: T_MEDIUM });
      urlMain = await waitForGuestOrigin(window.locator("webview").first());
    });

    test("feature-worktree panel reaches Running with a DIFFERENT port", async () => {
      const { window } = ctx;

      await switchWorktree(window, FEATURE_BRANCH);

      const idsBefore = await getGridPanelIds(window);
      await clickToolbarButton(window, SEL.toolbar.openDevPreview, T_MEDIUM);
      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_LONG })
        .toBe(idsBefore.length + 1);

      // Identify the new panel by diffing ids rather than relying on DOM order.
      const idsAfter = await getGridPanelIds(window);
      featurePanelId = idsAfter.find((id) => !idsBefore.includes(id)) ?? "";
      expect(featurePanelId).toBeTruthy();
      const featurePanel = window.locator(`[data-panel-id="${featurePanelId}"]`);

      const consoleBar = featurePanel.locator('[aria-controls^="console-drawer-"]').locator("..");
      const statusBadge = consoleBar.locator('[role="status"]');
      await expect(statusBadge).toContainText("Running", { timeout: T_LONG });

      const addressBar = featurePanel.locator(SEL.browser.addressBar);
      await expect(addressBar).toHaveValue(DEV_PREVIEW_ADDRESS_BAR_RE, {
        timeout: T_MEDIUM,
      });
      const urlFeature = await waitForGuestOrigin(featurePanel.locator("webview"));

      // They may share the reverse-proxy port, so compare the whole origin.
      expect(urlFeature).not.toBe(urlMain);
    });

    test("getByWorktree IPC returns the correct session for each worktree", async () => {
      const { window } = ctx;

      const mainSession = await getWorktreeSession(window, mainWorktreeId);
      const featureSession = await getWorktreeSession(window, featureWorktreeId);

      expect(mainSession?.status).toBe("running");
      expect(featureSession?.status).toBe("running");
      expect(mainSession?.worktreeId).toBe(mainWorktreeId);
      expect(featureSession?.worktreeId).toBe(featureWorktreeId);

      // The session tracks the upstream localhost URL printed by the dev server;
      // the address bar uses the stable dev-preview proxy origin.
      upstreamUrlMain = parseUpstreamOrigin(mainSession?.predictedUrl);
      const upstreamUrlFeature = parseUpstreamOrigin(featureSession?.predictedUrl);
      expect(upstreamUrlFeature).not.toBe(upstreamUrlMain);

      expect(mainSession?.panelId).not.toBe(featureSession?.panelId);
    });

    test("stopping feature-worktree panel leaves main-worktree session intact", async () => {
      const { window } = ctx;

      const panelsBefore = await getGridPanelIds(window);
      expect(panelsBefore).toContain(featurePanelId);

      const featurePanel = window.locator(`[data-panel-id="${featurePanelId}"]`);
      await featurePanel.locator(SEL.panel.close).click({ force: true });
      await expect
        .poll(() => getGridPanelCount(window), { timeout: T_MEDIUM })
        .toBe(panelsBefore.length - 1);

      // stopByPanel deletes the session once the panel-close event is processed.
      await expect
        .poll(() => getWorktreeSession(window, featureWorktreeId), { timeout: T_MEDIUM })
        .toBeNull();

      const mainAfter = await getWorktreeSession(window, mainWorktreeId);
      expect(mainAfter?.status).toBe("running");
      expect(mainAfter?.predictedUrl).toBe(upstreamUrlMain);
    });
  });

  // Last: the promoted portal's native view sits above the renderer, so pointer
  // input to the grid after this point is unreliable. Promotes the main
  // worktree's panel, which the registry block leaves running.
  test.describe.serial("Promote to Portal", () => {
    test("promoting a dev preview opens a portal tab sharing the session cookie", async () => {
      test.info().annotations.push({
        type: "platform-skip",
        description: "Windows CI: portal not supported with GPU disabled",
      });
      test.skip(
        process.platform === "win32" && !!process.env.CI,
        "Windows CI: portal not supported with GPU disabled"
      );
      const { window } = ctx;

      await switchWorktree(window, "main");

      // The address bar shows the dev server's own address; the guest (and the
      // portal tab promoted from it) sits on the panel's stable proxy origin.
      const consoleBar = window.locator('[aria-controls^="console-drawer-"]').locator("..").first();
      await expect(consoleBar.locator('[role="status"]')).toContainText("Running", {
        timeout: T_LONG,
      });
      await expect(window.locator(SEL.browser.addressBar).first()).toHaveValue(
        DEV_PREVIEW_ADDRESS_BAR_RE,
        { timeout: T_LONG }
      );
      const portalUrlHost = new URL(await waitForGuestOrigin(window.locator("webview").first()))
        .host;

      // The server never sets this cookie, so the portal can only see it if
      // promotion preserves the dev-preview session partition.
      const readPreviewCookieState = async (): Promise<{ cookie: string; href: string } | null> => {
        try {
          return await window.evaluate(
            async ({ name, value }) => {
              const wv = document.querySelector("webview") as Electron.WebviewTag | null;
              if (!wv) return null;
              try {
                return await wv.executeJavaScript(`(() => {
                  document.cookie = ${JSON.stringify(`${name}=${value}; Path=/`)};
                  return { cookie: document.cookie, href: window.location.href };
                })()`);
              } catch {
                return null;
              }
            },
            { name: COOKIE_NAME, value: COOKIE_VALUE }
          );
        } catch {
          return null;
        }
      };

      await expect.poll(readPreviewCookieState, { timeout: T_LONG }).toEqual(
        expect.objectContaining({
          cookie: expect.stringContaining(`${COOKIE_NAME}=${COOKIE_VALUE}`),
          href: expect.stringContaining(portalUrlHost),
        })
      );

      // Promote from the toolbar's More menu (the real user path).
      await window.locator(SEL.browser.moreActions).click();
      const promoteBtn = window.locator(SEL.browser.promoteToPortal);
      await expect(promoteBtn).toBeVisible({ timeout: T_MEDIUM });
      await promoteBtn.click();

      const portalContainer = window.locator(SEL.portal.container);
      await expect(portalContainer).toBeVisible({ timeout: T_LONG });
      await expect(portalContainer.locator('[role="tab"]').first()).toBeVisible({
        timeout: T_MEDIUM,
      });

      // The promoted WebContentsView must share the dev-preview session: its
      // cookie jar carries the cookie set in the guest. The dev-preview guest
      // itself is a "webview" and is excluded.
      await expect
        .poll(
          async () =>
            ctx.app.evaluate(
              async ({ webContents }, { name, urlPart }) => {
                for (const wc of webContents.getAllWebContents()) {
                  if (wc.getType() === "webview") continue;
                  if (!wc.getURL().includes(urlPart)) continue;
                  const cookies = await wc.session.cookies.get({ name });
                  if (cookies.length > 0) return cookies[0]!.value;
                }
                return null;
              },
              { name: COOKIE_NAME, urlPart: portalUrlHost }
            ),
          { timeout: T_LONG }
        )
        .toBe(COOKIE_VALUE);
    });
  });
});
