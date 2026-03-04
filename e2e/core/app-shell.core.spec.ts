import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../helpers/timeouts";

let ctx: AppContext;

test.describe.serial("App Shell", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("app launches with correct title and version", async () => {
    const title = await ctx.window.title();
    expect(title).toContain("Canopy");

    const version = await ctx.app.evaluate(({ app }) => app.getVersion());
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("toolbar baseline buttons are visible", async () => {
    const { window } = ctx;

    await expect(window.locator(SEL.toolbar.toggleSidebar)).toBeVisible({ timeout: T_MEDIUM });
    await expect(window.locator(SEL.toolbar.openTerminal)).toBeVisible({ timeout: T_SHORT });
    await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible({ timeout: T_SHORT });
  });

  test("welcome screen shows Open Folder button", async () => {
    const { window } = ctx;
    await expect(window.getByRole("button", { name: "Open Folder" })).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("sidebar toggle hides and restores sidebar", async () => {
    const { window } = ctx;

    const sidebar = window.locator(SEL.sidebar.resizeHandle);
    await expect(sidebar).toBeVisible({ timeout: T_MEDIUM });

    await window.locator(SEL.toolbar.toggleSidebar).click();
    await expect(sidebar).not.toBeVisible({ timeout: T_SHORT });

    await window.locator(SEL.toolbar.toggleSidebar).click();
    await expect(sidebar).toBeVisible({ timeout: T_SHORT });
  });

  test("settings opens, navigates tabs, closes via Escape", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.openSettings).click();

    const heading = window.locator("h2", { hasText: "Settings" });
    await expect(heading).toBeVisible({ timeout: T_MEDIUM });

    const defaultTab = window.locator("h3", { hasText: "General" });
    await expect(defaultTab).toBeVisible({ timeout: T_SHORT });

    const tabs = [
      { nav: "Keyboard", title: "Keyboard Shortcuts" },
      { nav: "Terminal", title: "Panel Grid" },
      { nav: "Appearance", title: "Appearance" },
      { nav: "CLI Agents", title: "CLI Agents" },
      { nav: "GitHub", title: "GitHub Integration" },
      { nav: "Troubleshooting", title: "Troubleshooting" },
    ];

    for (const { nav, title } of tabs) {
      await window.locator(`${SEL.settings.navSidebar} button`, { hasText: nav }).click();
      await expect(window.locator("h3", { hasText: title })).toBeVisible({ timeout: T_SHORT });
    }

    await window.keyboard.press("Escape");
    await expect(heading).not.toBeVisible({ timeout: T_SHORT });
  });
});
