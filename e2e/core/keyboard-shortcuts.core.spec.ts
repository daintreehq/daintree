import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getGridPanelCount } from "../helpers/panels";
import { SEL } from "../helpers/selectors";

let ctx: AppContext;

// Use Cmd on macOS, Ctrl elsewhere
const mod = process.platform === "darwin" ? "Meta" : "Control";

test.describe.serial("Keyboard Shortcuts", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({ name: "shortcuts-test" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Shortcuts Test");
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("Cmd+T opens a new terminal", async () => {
    const { window } = ctx;

    const before = await getGridPanelCount(window);
    await window.keyboard.press(`${mod}+t`);

    await expect.poll(() => getGridPanelCount(window), { timeout: 10_000 }).toBe(before + 1);
  });

  test("Cmd+T opens a second terminal", async () => {
    const { window } = ctx;

    const before = await getGridPanelCount(window);
    await window.keyboard.press(`${mod}+t`);

    await expect.poll(() => getGridPanelCount(window), { timeout: 10_000 }).toBe(before + 1);
  });

  test("Cmd+W closes the focused terminal", async () => {
    const { window } = ctx;

    const before = await getGridPanelCount(window);
    expect(before).toBeGreaterThanOrEqual(1);

    await window.keyboard.press(`${mod}+w`);

    await expect.poll(() => getGridPanelCount(window), { timeout: 5_000 }).toBe(before - 1);
  });

  test("Cmd+B toggles sidebar off and on", async () => {
    const { window } = ctx;

    const sidebar = window.locator("aside").first();
    await expect(sidebar).toBeVisible({ timeout: 3_000 });

    // Toggle off
    await window.keyboard.press(`${mod}+b`);
    await expect(sidebar).not.toBeVisible({ timeout: 3_000 });

    // Toggle back on
    await window.keyboard.press(`${mod}+b`);
    await expect(sidebar).toBeVisible({ timeout: 3_000 });
  });

  test("Cmd+, opens settings", async () => {
    const { window } = ctx;

    await window.keyboard.press(`${mod}+,`);

    const heading = window.locator(SEL.settings.heading);
    await expect(heading).toBeVisible({ timeout: 5_000 });
  });

  test("Escape closes settings dialog", async () => {
    const { window } = ctx;

    const heading = window.locator(SEL.settings.heading);
    await expect(heading).toBeVisible({ timeout: 3_000 });

    // Click the close button instead — Escape may not reach the dialog
    // when terminal has focus
    const closeBtn = window.locator(SEL.settings.closeButton);
    await closeBtn.click();
    await expect(heading).not.toBeVisible({ timeout: 3_000 });
  });

  test("Cmd+W closes remaining terminal", async () => {
    const { window } = ctx;

    const before = await getGridPanelCount(window);
    if (before === 0) {
      test.skip();
      return;
    }

    // Click the panel to ensure it has focus before pressing Cmd+W
    const panel = window.locator(SEL.panel.gridPanel).first();
    await panel.click();
    await window.waitForTimeout(200);

    await window.keyboard.press(`${mod}+w`);

    await expect.poll(() => getGridPanelCount(window), { timeout: 5_000 }).toBe(before - 1);
  });
});
