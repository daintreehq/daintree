import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount } from "../../helpers/panels";
import { saveCurrentProjectSettings } from "../../helpers/projectSettings";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;
const PROJECT_NAME = "Promote To Portal Test";
const COOKIE_NAME = "dt_promote_e2e";
const COOKIE_VALUE = "carried-over";
const DEV_PREVIEW_ADDRESS_BAR_RE = /^(?:https?:\/\/)?(?:localhost|dp-[a-z0-9-]+\.localhost):\d+$/;
const DEV_PREVIEW_READY_TIMEOUT = T_LONG * 6;

const DEV_SERVER_SCRIPT = `
const http = require('http');
const port = parseInt(process.env.PORT || '0', 10);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><head><title>Promote E2E</title></head><body><h1>Promote E2E</h1></body></html>');
});

server.listen(port, '127.0.0.1', () => {
  console.log('http://localhost:' + server.address().port);
});
`;

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

    const fixture = createFixtureRepo({ name: "promote-portal-test" });
    fixtureCleanup = fixture.cleanup;
    writeFileSync(path.join(fixture.dir, "dev-server.cjs"), DEV_SERVER_SCRIPT);

    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixture.dir, PROJECT_NAME);

    await saveCurrentProjectSettings(ctx.window, { devServerCommand: "node dev-server.cjs" });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
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

    // 2. Wait for the configured dev server to be running, then write a cookie
    //    into the preview webview's partition. The server never sets this
    //    cookie, so the portal can only see it if promotion preserves the
    //    dev-preview session partition.
    const consoleBar = window.locator('[aria-controls^="console-drawer-"]').locator("..").first();
    const statusBadge = consoleBar.locator('[role="status"]');
    await expect(statusBadge).toContainText("Running", { timeout: DEV_PREVIEW_READY_TIMEOUT });

    const addressBar = window.locator(SEL.browser.addressBar);
    await expect(addressBar).toHaveValue(DEV_PREVIEW_ADDRESS_BAR_RE, {
      timeout: DEV_PREVIEW_READY_TIMEOUT,
    });
    const displayUrl = (await addressBar.inputValue()).trim();
    const portalUrlHost = new URL(displayUrl.includes("://") ? displayUrl : `http://${displayUrl}`)
      .host;

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

    await expect.poll(readPreviewCookieState, { timeout: DEV_PREVIEW_READY_TIMEOUT }).toEqual(
      expect.objectContaining({
        cookie: expect.stringContaining(`${COOKIE_NAME}=${COOKIE_VALUE}`),
        href: expect.stringContaining(portalUrlHost),
      })
    );

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
    //    portal tab is a separate WebContents from the dev-preview guest, whose
    //    type is "webview" and is excluded.
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
