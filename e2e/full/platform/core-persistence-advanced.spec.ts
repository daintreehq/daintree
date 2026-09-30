import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, waitForProcessExit, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import {
  getGridPanelCount,
  getDockPanelCount,
  openTerminal,
  openSettings,
} from "../../helpers/panels";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const REBOUND_OPEN_SETTINGS = "Control+Shift+KeyZ";

async function openSettingsTab(window: Page, tab: string): Promise<void> {
  await openSettings(window);
  await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  const navTab = window.locator(`${SEL.settings.navSidebar} [id="settings-tab-${tab}"]`);
  await navTab.click();
  await expect(navTab).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
}

async function findOpenSettingsShortcutRow(window: Page) {
  const searchInput = window.locator(SEL.settings.shortcutsSearchInput);
  await searchInput.fill("Open settings");
  const row = window.locator(SEL.settings.shortcutRow).filter({ hasText: "Open settings" }).first();
  await expect(row).toBeVisible({ timeout: T_MEDIUM });
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  return row;
}

/**
 * One relaunch pair covers everything that has to survive a restart: the panel
 * layout, window bounds and collapsed sidebar, plus the theme, a notification
 * toggle and a rebound shortcut — which must still fire after the relaunch.
 */
test.describe.serial("Persistence: layout, window and preferences across restart", () => {
  let userDataDir: string;
  let fixtureDir: string;
  let fixtureCleanup: () => void;
  let ctx: AppContext | null = null;

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-persist-"));
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({ name: "persist-layout" }));
  });

  test.afterAll(async () => {
    if (ctx?.app) {
      const pid = ctx.app.process().pid;
      await closeApp(ctx.app);
      if (pid) await waitForProcessExit(pid).catch(() => {});
      ctx = null;
    }
    removePathSync(userDataDir);
    fixtureCleanup?.();
  });

  test("session 1: configure layout, window, theme, notifications and a keybinding", async () => {
    ctx = await launchApp({ userDataDir });
    const { app } = ctx;
    let window = ctx.window;

    // Theme is seeded over IPC (setup, not the subject) before the project opens.
    await window.evaluate(async () => {
      await globalThis.window.electron.appTheme.setColorScheme("bondi");
    });
    await window.reload({ waitUntil: "domcontentloaded" });
    await window
      .locator(SEL.toolbar.toggleSidebar)
      .waitFor({ state: "visible", timeout: T_MEDIUM });
    await expect(window.locator("html")).toHaveAttribute("data-theme", "bondi", {
      timeout: T_MEDIUM,
    });

    window = await openAndOnboardProject(app, window, fixtureDir, "Persist Layout");
    ctx.window = window;

    await openTerminal(window);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
    await openTerminal(window);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);

    const firstGridPanel = window.locator(SEL.panel.gridPanel).first();
    await firstGridPanel.hover();
    await firstGridPanel.locator(SEL.panel.minimize).click();
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
    await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(1);

    await openSettingsTab(window, "notifications");
    const notifCheckbox = window.locator(SEL.settings.notifCompletedCheckbox);
    await expect(notifCheckbox).not.toBeChecked({ timeout: T_MEDIUM });
    await notifCheckbox.click();
    await expect(notifCheckbox).toBeChecked({ timeout: T_SHORT });

    const keyboardTab = window.locator(`${SEL.settings.navSidebar} [id="settings-tab-keyboard"]`);
    await keyboardTab.click();
    await expect(
      window.getByRole("dialog").getByRole("heading", { name: /Keyboard Shortcuts/i })
    ).toBeVisible({ timeout: T_SHORT });

    const row = await findOpenSettingsShortcutRow(window);
    const editBtn = row.getByRole("button", { name: /^Edit shortcut for/ });
    await expect(editBtn).toBeVisible({ timeout: T_SHORT });
    await editBtn.click();
    const recordPrompt = window.locator(SEL.settings.shortcutRecordPrompt);
    await expect(recordPrompt).toBeVisible({ timeout: T_SHORT });
    await recordPrompt.click();
    await window.keyboard.press(REBOUND_OPEN_SETTINGS);

    // Save enables once the chord window closes and the combo is captured.
    const saveBtn = window
      .locator(SEL.settings.shortcutCancelButton)
      .locator("..")
      .locator("button", { hasText: "Save" });
    await expect(saveBtn).toBeEnabled({ timeout: T_MEDIUM });
    await saveBtn.click();
    await expect(recordPrompt).not.toBeVisible({ timeout: T_SHORT });

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setBounds({ x: 100, y: 100, width: 1000, height: 700 });
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const { width, height } = BrowserWindow.getAllWindows()[0].getBounds();
          return `${width}x${height}`;
        })
      )
      .toBe("1000x700");
    // timer: windowState bounds save debounce (500ms) — closeApp does not
    // reliably run the window's close-time flush, so let the debounced write land.
    await window.waitForTimeout(750);

    // Focus mode collapses the sidebar — the aside stays attached with aria-hidden.
    await window.locator(SEL.toolbar.toggleSidebar).click();
    await expect(window.locator(SEL.sidebar.aside)).toHaveAttribute("aria-hidden", "true", {
      timeout: T_SHORT,
    });

    const pid = app.process().pid!;
    await closeApp(app);
    await waitForProcessExit(pid);
    ctx = null;
  });

  test("session 2: everything configured in session 1 is restored", async () => {
    ctx = await launchApp({ userDataDir });
    const { window, app } = ctx;

    await expect(window.locator(SEL.toolbar.projectSwitcherTrigger)).toContainText(
      "persist-layout",
      { timeout: T_MEDIUM }
    );

    await expect
      .poll(() => getGridPanelCount(window), { timeout: T_LONG })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => getDockPanelCount(window), { timeout: T_LONG })
      .toBeGreaterThanOrEqual(1);
    await expect(window.locator(SEL.sidebar.aside)).toHaveAttribute("aria-hidden", "true", {
      timeout: T_SHORT,
    });

    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds()
    );
    expect(bounds.width).toBeGreaterThanOrEqual(990);
    expect(bounds.width).toBeLessThanOrEqual(1010);
    expect(bounds.height).toBeGreaterThanOrEqual(690);
    expect(bounds.height).toBeLessThanOrEqual(710);

    // bondi is light and non-default.
    await expect(window.locator("html")).toHaveAttribute("data-theme", "bondi", {
      timeout: T_MEDIUM,
    });
    await expect(window.locator("html")).toHaveAttribute("data-color-mode", "light", {
      timeout: T_MEDIUM,
    });

    // The rebound chord opens Settings in the relaunched app.
    await window.locator(SEL.toolbar.projectSwitcherTrigger).focus();
    await window.keyboard.press(REBOUND_OPEN_SETTINGS);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

    const notificationsTab = window.locator(
      `${SEL.settings.navSidebar} [id="settings-tab-notifications"]`
    );
    await notificationsTab.click();
    await expect(window.locator(SEL.settings.notifCompletedCheckbox)).toBeChecked({
      timeout: T_MEDIUM,
    });

    await window.locator(`${SEL.settings.navSidebar} [id="settings-tab-keyboard"]`).click();
    const row = await findOpenSettingsShortcutRow(window);
    // The reset button only renders while an override exists.
    await expect(row.locator(SEL.settings.shortcutResetButton)).toBeVisible({
      timeout: T_MEDIUM,
    });

    await window.locator(SEL.settings.closeButton).click();
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
  });
});
