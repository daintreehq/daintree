import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "../helpers/launch";
import { SEL } from "../helpers/selectors";

let ctx: AppContext;

test.describe.serial("App Shell", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("app launches with correct title and version", async () => {
    const title = await ctx.window.title();
    expect(title).toContain("Canopy");

    const version = await ctx.app.evaluate(({ app }) => app.getVersion());
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("toolbar baseline buttons are visible", async () => {
    const { window } = ctx;

    await expect(window.locator(SEL.toolbar.toggleSidebar)).toBeVisible();
    await expect(window.locator(SEL.toolbar.openTerminal)).toBeVisible();
    await expect(window.locator(SEL.toolbar.openSettings)).toBeVisible();
  });

  test("welcome screen shows Open Folder button", async () => {
    const { window } = ctx;
    await expect(window.getByRole("button", { name: "Open Folder" })).toBeVisible();
  });

  test("sidebar toggle hides and restores sidebar", async () => {
    const { window } = ctx;

    const sidebar = window.locator(SEL.sidebar.resizeHandle);
    await expect(sidebar).toBeVisible({ timeout: 5_000 });

    await window.locator(SEL.toolbar.toggleSidebar).click();
    await expect(sidebar).not.toBeVisible({ timeout: 3_000 });

    await window.locator(SEL.toolbar.toggleSidebar).click();
    await expect(sidebar).toBeVisible({ timeout: 3_000 });
  });

  test("settings opens, navigates tabs, closes via Escape", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.openSettings).click();

    const heading = window.locator("h2", { hasText: "Settings" });
    await expect(heading).toBeVisible({ timeout: 5_000 });

    const defaultTab = window.locator("h3", { hasText: "General" });
    await expect(defaultTab).toBeVisible();

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
      await expect(window.locator("h3", { hasText: title })).toBeVisible({ timeout: 2_000 });
    }

    await window.keyboard.press("Escape");
    await expect(heading).not.toBeVisible({ timeout: 3_000 });
  });
});
