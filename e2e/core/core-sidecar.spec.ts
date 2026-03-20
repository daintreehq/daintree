import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let server: Server;
let port: number;

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
  return page.evaluate(([id, a]) => (window as any).__canopyDispatchAction(id, a), [
    actionId,
    args,
  ] as const);
}

test.describe.serial("Core: Sidecar Multi-Tab Lifecycle", () => {
  test.skip(
    process.platform === "win32" && !!process.env.CI,
    "Windows CI: sidecar not supported with GPU disabled"
  );

  test.beforeAll(async () => {
    server = createServer(handleRequest);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const fixture = createFixtureRepo({ name: "sidecar-test" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixture, "Sidecar Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    server?.close();
  });

  test.describe.serial("Tab Creation and Switching", () => {
    test("opens sidecar and creates first tab with URL", async () => {
      const { window } = ctx;

      const sidecarBtn = window.locator(SEL.toolbar.sidecarToggle);
      if (
        !(await sidecarBtn
          .first()
          .isVisible()
          .catch(() => false))
      ) {
        test.skip();
        return;
      }

      await dispatchAction(window, "sidecar.openUrl", {
        url: `http://127.0.0.1:${port}/page-a`,
        title: "Page A",
      });
      await window.waitForTimeout(T_SETTLE);

      // Sidecar toolbar should be visible with tab
      const sidecarContainer = window.locator(SEL.sidecar.container);
      await expect(sidecarContainer).toBeVisible({ timeout: T_LONG });

      // Tab should be present and active
      const tab = sidecarContainer.locator('[role="tab"][aria-label="Page A"]');
      await expect(tab).toBeVisible({ timeout: T_MEDIUM });
      await expect(tab).toHaveAttribute("aria-selected", "true");
    });

    test("creates second tab with different URL", async () => {
      const { window } = ctx;

      await dispatchAction(window, "sidecar.openUrl", {
        url: `http://127.0.0.1:${port}/page-b`,
        title: "Page B",
      });
      await window.waitForTimeout(T_SETTLE);

      const sidecarContainer = window.locator(SEL.sidecar.container);

      // Both tabs should exist
      const tabA = sidecarContainer.locator('[role="tab"][aria-label="Page A"]');
      const tabB = sidecarContainer.locator('[role="tab"][aria-label="Page B"]');
      await expect(tabA).toBeVisible({ timeout: T_MEDIUM });
      await expect(tabB).toBeVisible({ timeout: T_SHORT });

      // Second tab should be active, first inactive
      await expect(tabB).toHaveAttribute("aria-selected", "true");
      await expect(tabA).toHaveAttribute("aria-selected", "false");
    });

    test("clicking tab switches active tab", async () => {
      const { window } = ctx;

      const sidecarContainer = window.locator(SEL.sidecar.container);
      const tabA = sidecarContainer.locator('[role="tab"][aria-label="Page A"]');
      const tabB = sidecarContainer.locator('[role="tab"][aria-label="Page B"]');

      // Click first tab to switch back
      await tabA.click();
      await window.waitForTimeout(T_SETTLE);

      await expect(tabA).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
      await expect(tabB).toHaveAttribute("aria-selected", "false", { timeout: T_SHORT });

      // Click second tab to switch again
      await tabB.click();
      await window.waitForTimeout(T_SETTLE);

      await expect(tabB).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
      await expect(tabA).toHaveAttribute("aria-selected", "false", { timeout: T_SHORT });
    });
  });

  test.describe.serial("Tab Close", () => {
    test("closing one tab leaves the other active", async () => {
      const { window } = ctx;

      const sidecarContainer = window.locator(SEL.sidecar.container);

      // Close Page B (currently active)
      const closeBtn = sidecarContainer.locator('[aria-label="Close Page B"]');
      await closeBtn.click();
      await window.waitForTimeout(T_SETTLE);

      // Page B should be gone, Page A should remain and become active
      await expect(sidecarContainer.locator('[role="tab"][aria-label="Page B"]')).not.toBeVisible({
        timeout: T_MEDIUM,
      });
      const tabA = sidecarContainer.locator('[role="tab"][aria-label="Page A"]');
      await expect(tabA).toBeVisible({ timeout: T_SHORT });
      await expect(tabA).toHaveAttribute("aria-selected", "true");
    });

    test("closing last tab hides sidecar content", async () => {
      const { window } = ctx;

      const sidecarContainer = window.locator(SEL.sidecar.container);

      // Close the remaining tab (Page A)
      const closeBtn = sidecarContainer.locator('[aria-label="Close Page A"]');
      await closeBtn.click();
      await window.waitForTimeout(T_SETTLE);

      // No tabs should remain
      await expect(sidecarContainer.locator('[role="tab"]')).toHaveCount(0, { timeout: T_MEDIUM });
    });
  });

  test.describe.serial("Settings Overlay Interaction", () => {
    test("opening Settings closes sidecar, reopening works after", async () => {
      const { window } = ctx;

      // Open sidecar with a tab
      await dispatchAction(window, "sidecar.openUrl", {
        url: `http://127.0.0.1:${port}/page-a`,
        title: "Page A",
      });
      await window.waitForTimeout(T_SETTLE);

      const sidecarContainer = window.locator(SEL.sidecar.container);
      await expect(sidecarContainer).toBeVisible({ timeout: T_LONG });

      // Open Settings dialog
      await window.locator(SEL.toolbar.openSettings).click();
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      // Sidecar should be closed
      await expect(sidecarContainer).not.toBeVisible({ timeout: T_MEDIUM });

      // Close Settings
      await window.locator(SEL.settings.closeButton).click();
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

      // Reopen sidecar
      await window.locator(SEL.toolbar.sidecarToggle).first().click();
      await window.waitForTimeout(T_SETTLE);

      // Sidecar should be visible again with the tab still present
      await expect(sidecarContainer).toBeVisible({ timeout: T_LONG });
      await expect(sidecarContainer.locator('[role="tab"][aria-label="Page A"]')).toBeVisible({
        timeout: T_MEDIUM,
      });
    });
  });
});
