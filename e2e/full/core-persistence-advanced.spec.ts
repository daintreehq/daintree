import { test, expect } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";
import {
  getGridPanelCount,
  getDockPanelCount,
  openTerminal,
  openSettings,
} from "../helpers/panels";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

test.describe.serial("Persistence: Layout & Window across restart", () => {
  let userDataDir: string;
  let fixtureDir: string;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "canopy-e2e-persist-layout-"));
    fixtureDir = createFixtureRepo({ name: "persist-layout" });
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  test("terminal layout, window size, and sidebar state survive restart", async () => {
    // Session 1: configure layout, resize window, toggle focus mode, close
    ctx = await launchApp({ userDataDir });
    const { app: app1 } = ctx;
    let { window: w1 } = ctx;

    w1 = await openAndOnboardProject(app1, w1, fixtureDir, "Persist Layout");

    // Open two terminals explicitly
    await openTerminal(w1);
    await expect.poll(() => getGridPanelCount(w1), { timeout: T_MEDIUM }).toBe(1);
    await openTerminal(w1);
    await expect.poll(() => getGridPanelCount(w1), { timeout: T_MEDIUM }).toBe(2);

    // Minimize one panel to dock
    const firstGridPanel = w1.locator(SEL.panel.gridPanel).first();
    await firstGridPanel.hover();
    await firstGridPanel.locator(SEL.panel.minimize).click();
    await expect.poll(() => getGridPanelCount(w1), { timeout: T_MEDIUM }).toBe(1);
    await expect.poll(() => getDockPanelCount(w1), { timeout: T_MEDIUM }).toBe(1);

    // Resize window to 1000x700
    await app1.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setBounds({ x: 100, y: 100, width: 1000, height: 700 });
    });
    await w1.waitForTimeout(T_SETTLE);

    // Toggle focus mode (hides sidebar)
    await w1.locator(SEL.toolbar.toggleSidebar).click();
    await expect(w1.locator('aside[aria-label="Sidebar"]')).not.toBeVisible({
      timeout: T_SHORT,
    });
    await w1.waitForTimeout(T_SETTLE);

    const pid1 = app1.process().pid!;
    await closeApp(app1);
    await waitForProcessExit(pid1);
    ctx = null;

    // Session 2: verify layout, window size, and sidebar state persisted
    ctx = await launchApp({ userDataDir });
    const { window: w2, app: app2 } = ctx;

    // Wait for project to restore
    await expect(w2.locator(SEL.toolbar.projectSwitcherTrigger)).toContainText("Persist Layout", {
      timeout: T_MEDIUM,
    });

    // Verify terminal layout: at least 1 grid + 1 dock
    await expect.poll(() => getGridPanelCount(w2), { timeout: T_LONG }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => getDockPanelCount(w2), { timeout: T_LONG }).toBeGreaterThanOrEqual(1);

    // Verify sidebar is still hidden (focus mode persisted)
    await expect(w2.locator('aside[aria-label="Sidebar"]')).not.toBeVisible({
      timeout: T_SHORT,
    });

    // Verify window dimensions within tolerance
    const bounds = await app2.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.getBounds();
    });
    expect(bounds.width).toBeGreaterThanOrEqual(990);
    expect(bounds.width).toBeLessThanOrEqual(1010);
    expect(bounds.height).toBeGreaterThanOrEqual(690);
    expect(bounds.height).toBeLessThanOrEqual(710);
  });
});

test.describe.serial("Persistence: Theme, Notifications & Keybindings across restart", () => {
  let userDataDir: string;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "canopy-e2e-persist-global-"));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    rmSync(userDataDir, { recursive: true, force: true });
  });

  test("theme, notification toggle, and keybinding override survive restart", async () => {
    // Session 1: set theme, toggle notification, record keybinding, close
    ctx = await launchApp({ userDataDir });
    const { window: w1, app: app1 } = ctx;

    // Set theme to "bondi" (light, non-default) via IPC and reload
    await w1.evaluate(async () => {
      await window.electron.appTheme.setColorScheme("bondi");
    });
    await w1.reload({ waitUntil: "domcontentloaded" });
    await w1.locator(SEL.toolbar.toggleSidebar).waitFor({ state: "visible", timeout: T_MEDIUM });

    // Verify theme applied
    await expect(w1.locator("html")).toHaveAttribute("data-theme", "bondi", {
      timeout: T_MEDIUM,
    });

    // Open Settings > Notifications
    await openSettings(w1);
    await expect(w1.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await w1.locator(`${SEL.settings.navSidebar} button`, { hasText: "Notifications" }).click();
    await expect(w1.locator("h3", { hasText: "Notifications" })).toBeVisible({
      timeout: T_SHORT,
    });
    await expect(w1.locator("text=Loading…")).not.toBeVisible({ timeout: T_MEDIUM });

    // Toggle completed notification on
    const notifCheckbox = w1.locator(SEL.settings.notifCompletedCheckbox);
    await expect(notifCheckbox).not.toBeChecked({ timeout: T_SHORT });
    await notifCheckbox.click();
    await expect(notifCheckbox).toBeChecked({ timeout: T_SHORT });

    // Navigate to Keyboard tab
    await w1.locator(`${SEL.settings.navSidebar} button`, { hasText: "Keyboard" }).click();
    await expect(
      w1.getByRole("dialog").getByRole("heading", { name: "Keyboard Shortcuts" })
    ).toBeVisible({ timeout: T_SHORT });

    // Record a keybinding override for "Open settings"
    const searchInput = w1.locator(SEL.settings.shortcutsSearchInput);
    await searchInput.fill("Open settings");
    await w1.waitForTimeout(T_SETTLE);

    const row = w1
      .locator(".group")
      .filter({ has: w1.locator("button", { hasText: "Edit" }) })
      .first();
    await row.scrollIntoViewIfNeeded();
    await row.hover();

    const editBtn = row.locator("button", { hasText: "Edit" });
    await expect(editBtn).toBeVisible({ timeout: T_SHORT });
    await editBtn.click();

    const recordPrompt = w1.locator(SEL.settings.shortcutRecordPrompt);
    await expect(recordPrompt).toBeVisible({ timeout: T_SHORT });
    await recordPrompt.click();

    await w1.keyboard.press("Control+Shift+KeyZ");
    await w1.waitForTimeout(1500); // chord timeout

    const recorderArea = w1.locator(SEL.settings.shortcutCancelButton).locator("..");
    const saveBtn = recorderArea.locator("button", { hasText: "Save" });
    await expect(saveBtn).toBeVisible({ timeout: T_SHORT });
    await saveBtn.click();
    await w1.waitForTimeout(T_SETTLE);

    // Close settings
    await w1.keyboard.press("Escape");
    await expect(w1.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    await w1.waitForTimeout(T_SETTLE);

    const pid1 = app1.process().pid!;
    await closeApp(app1);
    await waitForProcessExit(pid1);
    ctx = null;

    // Session 2: verify theme, notification, and keybinding persisted
    ctx = await launchApp({ userDataDir });
    const { window: w2 } = ctx;

    // Verify theme persisted (bondi is light, non-default)
    await expect(w2.locator("html")).toHaveAttribute("data-theme", "bondi", {
      timeout: T_MEDIUM,
    });
    await expect(w2.locator("html")).toHaveAttribute("data-color-mode", "light", {
      timeout: T_MEDIUM,
    });

    // Verify notification toggle persisted
    await openSettings(w2);
    await expect(w2.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    await w2.locator(`${SEL.settings.navSidebar} button`, { hasText: "Notifications" }).click();
    await expect(w2.locator("text=Loading…")).not.toBeVisible({ timeout: T_MEDIUM });

    const notifCheckbox2 = w2.locator(SEL.settings.notifCompletedCheckbox);
    await expect(notifCheckbox2).toBeChecked({ timeout: T_SHORT });

    // Verify keybinding override persisted
    await w2.locator(`${SEL.settings.navSidebar} button`, { hasText: "Keyboard" }).click();
    await expect(w2.locator("h3", { hasText: "Keyboard Shortcuts" })).toBeVisible({
      timeout: T_SHORT,
    });

    const searchInput2 = w2.locator(SEL.settings.shortcutsSearchInput);
    await searchInput2.fill("Open settings");
    await w2.waitForTimeout(T_SETTLE);

    const row2 = w2
      .locator(".group")
      .filter({ has: w2.locator("button", { hasText: "Edit" }) })
      .first();
    await row2.scrollIntoViewIfNeeded();
    await row2.hover();

    // Reset button is only visible when an override exists
    const resetBtn = row2.locator(SEL.settings.shortcutResetButton);
    await expect(resetBtn).toBeVisible({ timeout: T_MEDIUM });

    await w2.keyboard.press("Escape");
  });
});
