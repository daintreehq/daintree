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
    const prefs = await ctx.app.evaluate(
      ({ BrowserWindow }, { pageTitle }) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => w.webContents.getTitle() === pageTitle
        );
        return win?.webContents.getLastWebPreferences() ?? null;
      },
      { pageTitle: await ctx.window.title() }
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
