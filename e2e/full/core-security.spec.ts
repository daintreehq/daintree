import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";

let ctx: AppContext;

test.describe.serial("Core: Security", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("renderer does not expose require", async () => {
    const t = await ctx.window.evaluate(() => typeof require);
    expect(t).toBe("undefined");
  });

  test("renderer does not expose process", async () => {
    const t = await ctx.window.evaluate(() => typeof process);
    expect(t).toBe("undefined");
  });

  test("main window uses secure webPreferences", async () => {
    // After WebContentsView migration, the test page is the inner
    // WebContentsView, not the BrowserWindow's main webContents. Look it up
    // by URL across all alive webContents to verify *its* preferences.
    const prefs = await ctx.app.evaluate(
      ({ webContents }, { pageUrl }) => {
        const wc = webContents.getAllWebContents().find((c) => c.getURL() === pageUrl);
        return wc?.getLastWebPreferences() ?? null;
      },
      { pageUrl: ctx.window.url() }
    );
    expect(prefs).not.toBeNull();
    expect(prefs!.contextIsolation).toBe(true);
    expect(prefs!.nodeIntegration).toBe(false);
    expect(prefs!.webSecurity).toBe(true);
  });

  test("document includes a non-empty CSP meta tag", async () => {
    const content = await ctx.window
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(content).toMatch(/\b(default-src|script-src)\b/);
  });
});
