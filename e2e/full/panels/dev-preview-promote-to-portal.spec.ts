import { test, expect } from "@playwright/test";
import { createServer, type Server } from "http";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let server: Server;
let port: number;
let fixtureCleanup: (() => void) | undefined;
const PROJECT_NAME = "Promote To Portal Test";
const COOKIE_NAME = "dt_promote_e2e";
const COOKIE_VALUE = "carried-over";

test.describe.serial("Core: Dev preview promote to portal", () => {
  test.beforeAll(async () => {
    test.info().annotations.push({
      type: "platform-skip",
      description: "Windows CI: portal not supported with GPU disabled",
    });
    test.skip(
      process.platform === "win32" && !!process.env.CI,
      "Windows CI: portal not supported with GPU disabled"
    );

    // Set the cookie exactly once (on the dev-preview webview's first load).
    // Later loads — including the promoted portal tab's own navigation — get NO
    // Set-Cookie, so the cookie can only be present in the portal view if it
    // genuinely shares the dev-preview session partition. A view opened on the
    // default `persist:portal` session would see no cookie and fail the test.
    let cookieSent = false;
    server = createServer((_req, res) => {
      const headers: Record<string, string> = { "Content-Type": "text/html" };
      if (!cookieSent) {
        cookieSent = true;
        headers["Set-Cookie"] = `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/`;
      }
      res.writeHead(200, headers);
      res.end(
        "<html><head><title>Promote E2E</title></head><body><h1>Promote E2E</h1></body></html>"
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;

    const fixture = createFixtureRepo({ name: "promote-portal-test" });
    fixtureCleanup = fixture.cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, PROJECT_NAME);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    server?.close();
    fixtureCleanup?.();
  });

  test("promoting a dev preview opens a portal tab sharing the session cookie", async () => {
    const { window } = ctx;

    // 1. Open a dev-preview panel.
    const devBtn = window.locator(SEL.toolbar.openDevPreview);
    if (!(await devBtn.isVisible().catch(() => false))) {
      test.info().annotations.push({
        type: "conditional-skip",
        description: "Dev preview toolbar button not visible in this launch state",
      });
      test.skip();
      return;
    }
    const before = await getGridPanelCount(window);
    await devBtn.click();
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(before + 1);

    // 2. Navigate the preview webview to the local server (sets the cookie on the
    //    dev-preview partition via the Set-Cookie response header).
    const addressBar = window.locator(SEL.browser.addressBar);
    if (!(await addressBar.isVisible({ timeout: T_SHORT }).catch(() => false))) {
      test.info().annotations.push({
        type: "conditional-skip",
        description: "Dev preview address bar not visible (panel not open)",
      });
      test.skip();
      return;
    }
    await addressBar.click();
    await addressBar.fill(`http://127.0.0.1:${port}/`);
    await window.keyboard.press("Enter");
    await expect(addressBar).toHaveValue(new RegExp(`127\\.0\\.0\\.1:${port}`), {
      timeout: T_MEDIUM,
    });
    await window.waitForTimeout(T_SETTLE);

    // 3. Promote to portal via the toolbar button (the real user path).
    const promoteBtn = window.locator(SEL.browser.promoteToPortal);
    await expect(promoteBtn).toBeVisible({ timeout: T_MEDIUM });
    await promoteBtn.click();
    await window.waitForTimeout(T_SETTLE);

    // 4. A portal tab for the dev preview should now exist.
    const portalContainer = window.locator(SEL.portal.container);
    await expect(portalContainer).toBeVisible({ timeout: T_LONG });
    await expect(portalContainer.locator('[role="tab"]').first()).toBeVisible({
      timeout: T_MEDIUM,
    });

    // 5. The promoted WebContentsView must share the dev-preview session: its
    //    cookie jar carries the cookie set during the webview navigation. The
    //    portal tab renders as a WebContentsView (type "browserView"); the
    //    dev-preview guest is a "webview" and is excluded.
    await expect
      .poll(
        async () =>
          ctx.app.evaluate(
            async ({ webContents }, { name, urlPart }) => {
              for (const wc of webContents.getAllWebContents()) {
                if (wc.getType() !== "browserView") continue;
                if (!wc.getURL().includes(urlPart)) continue;
                const cookies = await wc.session.cookies.get({ name });
                if (cookies.length > 0) return cookies[0]!.value;
              }
              return null;
            },
            { name: COOKIE_NAME, urlPart: `127.0.0.1:${port}` }
          ),
        { timeout: T_LONG }
      )
      .toBe(COOKIE_VALUE);
  });
});
