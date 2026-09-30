import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { PORTAL_DEFAULT_WIDTH } from "../../../shared/types/portal";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { openSettings } from "../../helpers/panels";

let ctx: AppContext | null = null;
let server: Server;
let port: number;
let userDataDir: string;
let savedWidth = 0;

const WINDOWS_CI_PORTAL_SKIP = "Windows CI: portal not supported with GPU disabled";

function handleRequest(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/html" });
  const url = _req.url ?? "/";
  if (url.startsWith("/page-a")) {
    res.end("<html><head><title>Page A</title></head><body><h1>Page A</h1></body></html>");
  } else if (url.startsWith("/page-b")) {
    res.end("<html><head><title>Page B</title></head><body><h1>Page B</h1></body></html>");
  } else {
    res.end("<html><head><title>Home</title></head><body><h1>Home</h1></body></html>");
  }
}

async function dispatchAction(page: Page, actionId: string, args?: unknown): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate(([id, a]) => (window as any).__daintreeDispatchAction(id, a), [
    actionId,
    args,
  ] as const);
}

// Tab tests render a WebContentsView per tab, which Windows CI (GPU disabled)
// cannot host. The toolbar toggle, launchpad, resize and width persistence
// tests do not create tabs, so they keep running there.
function skipTabsOnWindowsCI(): void {
  test.info().annotations.push({ type: "platform-skip", description: WINDOWS_CI_PORTAL_SKIP });
  test.skip(process.platform === "win32" && !!process.env.CI, WINDOWS_CI_PORTAL_SKIP);
}

function app(): AppContext {
  if (!ctx) throw new Error("App is not running");
  return ctx;
}

// Serial: one journey on one app — the tab tests build on each other and the
// final relaunch verifies the width the resize test left behind.
test.describe.serial("Core: Portal", () => {
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    server = createServer(handleRequest);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const fixture = createFixtureRepo({ name: "portal-test" });
    fixtureCleanup = fixture.cleanup;
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-portal-"));
    ctx = await launchApp({ userDataDir });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, "Portal Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    server?.close();
    fixtureCleanup?.();
    if (userDataDir) removePathSync(userDataDir);
  });

  test.describe("Panel toggle and resize", () => {
    test("opens via toolbar toggle", async () => {
      const { window } = app();

      const toggle = window.locator(SEL.toolbar.portalToggle);
      await expect(toggle).toBeVisible({ timeout: T_MEDIUM });
      await toggle.click();

      await expect(window.locator(SEL.portal.region)).toBeVisible({ timeout: T_MEDIUM });
      await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: T_SHORT });
    });

    test("shows launchpad content", async () => {
      const { window } = app();

      await expect(window.locator(SEL.portal.launchpadHeading)).toBeVisible({ timeout: T_SHORT });
    });

    test("closes via toolbar toggle", async () => {
      const { window } = app();

      const toggle = window.locator(SEL.toolbar.portalToggle);
      await toggle.click();
      await expect(window.locator(SEL.portal.region)).toBeHidden({ timeout: T_SHORT });
      await expect(toggle).toHaveAttribute("aria-pressed", "false", { timeout: T_SHORT });
    });

    test("resizes via keyboard", async () => {
      const { window } = app();

      await window.locator(SEL.toolbar.portalToggle).click();
      await expect(window.locator(SEL.portal.region)).toBeVisible({ timeout: T_MEDIUM });

      const handle = window.locator(SEL.portal.resizeHandle);
      await handle.focus();

      const before = Number(await handle.getAttribute("aria-valuenow"));
      expect(before).toBeGreaterThan(0);

      // ArrowLeft increases width (handle is on left edge of right-side panel)
      for (let i = 0; i < 5; i++) {
        await window.keyboard.press("ArrowLeft");
      }

      await expect
        .poll(async () => Number(await handle.getAttribute("aria-valuenow")), { timeout: T_SHORT })
        .toBeGreaterThan(before);
      await expect
        .poll(async () => Number(await handle.getAttribute("aria-valuenow")), { timeout: T_SHORT })
        .toBeGreaterThan(PORTAL_DEFAULT_WIDTH);
      savedWidth = Number(await handle.getAttribute("aria-valuenow"));

      await window.locator(SEL.toolbar.portalToggle).click();
      await expect(window.locator(SEL.portal.region)).toBeHidden({ timeout: T_SHORT });
    });
  });

  test.describe("Tab Creation and Switching", () => {
    test.beforeEach(skipTabsOnWindowsCI);

    test("opens portal and creates first tab with URL", async () => {
      const { window } = app();

      const portalBtn = window.locator(SEL.toolbar.portalToggle);
      await expect(portalBtn.first()).toBeVisible({ timeout: T_LONG });

      await dispatchAction(window, "portal.openUrl", {
        url: `http://127.0.0.1:${port}/page-a`,
        title: "Page A",
      });

      const portalContainer = window.locator(SEL.portal.container);
      await expect(portalContainer).toBeVisible({ timeout: T_LONG });

      const tab = portalContainer.locator('[role="tab"][aria-label="Page A"]');
      await expect(tab).toBeVisible({ timeout: T_MEDIUM });
      await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
    });

    test("creates second tab with different URL", async () => {
      const { window } = app();

      await dispatchAction(window, "portal.openUrl", {
        url: `http://127.0.0.1:${port}/page-b`,
        title: "Page B",
      });

      const portalContainer = window.locator(SEL.portal.container);

      const tabA = portalContainer.locator('[role="tab"][aria-label="Page A"]');
      const tabB = portalContainer.locator('[role="tab"][aria-label="Page B"]');
      await expect(tabA).toBeVisible({ timeout: T_MEDIUM });
      await expect(tabB).toBeVisible({ timeout: T_SHORT });

      await expect(tabB).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
      await expect(tabA).toHaveAttribute("aria-selected", "false", { timeout: T_SHORT });
    });

    test("clicking tab switches active tab", async () => {
      const { window } = app();

      const portalContainer = window.locator(SEL.portal.container);
      const tabA = portalContainer.locator('[role="tab"][aria-label="Page A"]');
      const tabB = portalContainer.locator('[role="tab"][aria-label="Page B"]');

      await tabA.click();
      await expect(tabA).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
      await expect(tabB).toHaveAttribute("aria-selected", "false", { timeout: T_SHORT });

      await tabB.click();
      await expect(tabB).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
      await expect(tabA).toHaveAttribute("aria-selected", "false", { timeout: T_SHORT });
    });
  });

  test.describe("Tab Close", () => {
    test.beforeEach(skipTabsOnWindowsCI);

    test("closing one tab leaves the other active", async () => {
      const { window } = app();

      const portalContainer = window.locator(SEL.portal.container);

      // Close Page B (currently active)
      await portalContainer.locator('[aria-label="Close Page B"]').click();

      await expect(portalContainer.locator('[role="tab"][aria-label="Page B"]')).not.toBeVisible({
        timeout: T_MEDIUM,
      });
      const tabA = portalContainer.locator('[role="tab"][aria-label="Page A"]');
      await expect(tabA).toBeVisible({ timeout: T_SHORT });
      await expect(tabA).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
    });

    test("closing last tab hides portal content", async () => {
      const { window } = app();

      const portalContainer = window.locator(SEL.portal.container);
      await portalContainer.locator('[aria-label="Close Page A"]').click();

      await expect(portalContainer.locator('[role="tab"]')).toHaveCount(0, { timeout: T_MEDIUM });
    });
  });

  test.describe("Settings Overlay Interaction", () => {
    test.beforeEach(skipTabsOnWindowsCI);

    test("opening Settings closes portal, reopening works after", async () => {
      const { window } = app();

      await dispatchAction(window, "portal.openUrl", {
        url: `http://127.0.0.1:${port}/page-a`,
        title: "Page A",
      });

      const portalContainer = window.locator(SEL.portal.container);
      await expect(portalContainer).toBeVisible({ timeout: T_LONG });

      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      await expect(portalContainer).not.toBeVisible({ timeout: T_MEDIUM });

      await window.locator(SEL.settings.closeButton).click();
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

      await window.locator(SEL.toolbar.portalToggle).first().click();

      await expect(portalContainer).toBeVisible({ timeout: T_LONG });
      await expect(portalContainer.locator('[role="tab"][aria-label="Page A"]')).toBeVisible({
        timeout: T_MEDIUM,
      });
    });
  });

  test.describe("Width persistence", () => {
    test("resized width survives app restart", async () => {
      expect(savedWidth).toBeGreaterThan(PORTAL_DEFAULT_WIDTH);
      const { app: electronApp, window: w1 } = app();

      // Leave the portal closed so session 2 opens it with the toggle.
      const toggle1 = w1.locator(SEL.toolbar.portalToggle);
      if ((await toggle1.getAttribute("aria-pressed")) === "true") {
        await toggle1.click();
      }
      await expect(toggle1).toHaveAttribute("aria-pressed", "false", { timeout: T_SHORT });

      // The portal store persists through a debounced localStorage write.
      await expect
        .poll(
          () =>
            w1.evaluate(() => {
              const raw = localStorage.getItem("portal-storage");
              return raw ? (JSON.parse(raw) as { state?: { width?: number } }).state?.width : null;
            }),
          { timeout: T_MEDIUM }
        )
        .toBe(savedWidth);

      const pid = electronApp.process().pid!;
      await closeApp(electronApp);
      await waitForProcessExit(pid);
      ctx = null;

      ctx = await launchApp({ userDataDir });
      const { window: w2 } = ctx;

      const toggle2 = w2.locator(SEL.toolbar.portalToggle);
      await expect(toggle2).toBeVisible({ timeout: T_MEDIUM });
      await toggle2.click();
      await expect(w2.locator(SEL.portal.region)).toBeVisible({ timeout: T_MEDIUM });

      const handle2 = w2.locator(SEL.portal.resizeHandle);
      await expect
        .poll(async () => Number(await handle2.getAttribute("aria-valuenow")), {
          timeout: T_MEDIUM,
        })
        .toBe(savedWidth);
    });
  });
});
