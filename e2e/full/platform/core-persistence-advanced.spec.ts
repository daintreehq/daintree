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
import { expectTerminalFocused } from "../../helpers/focus";

const MOD = process.platform === "darwin" ? "Meta" : "Control";
const REBOUND_OPEN_SETTINGS = "Control+Shift+KeyZ";
const DEFAULT_OPEN_SETTINGS = `${MOD}+Comma`;
// KeyM/KeyJ keep the physical key: Option+letter produces a symbol on macOS.
const DEFAULT_TOGGLE_DOCK = `${MOD}+Alt+KeyM`;
const REBOUND_TOGGLE_DOCK = `${MOD}+Alt+Shift+KeyJ`;
const TOGGLE_DOCK_LABEL = "Toggle focused terminal dock state";
const NO_OP_DWELL_MS = 750;

async function openSettingsTab(window: Page, tab: string): Promise<void> {
  await openSettings(window);
  await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  const navTab = window.locator(`${SEL.settings.navSidebar} [id="settings-tab-${tab}"]`);
  await navTab.click();
  await expect(navTab).toHaveAttribute("aria-selected", "true", { timeout: T_SHORT });
}

async function findShortcutRow(window: Page, label: string) {
  const searchInput = window.locator(SEL.settings.shortcutsSearchInput);
  await searchInput.fill(label);
  const row = window.locator(SEL.settings.shortcutRow).filter({ hasText: label }).first();
  await expect(row).toBeVisible({ timeout: T_MEDIUM });
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  return row;
}

async function recordShortcut(window: Page, label: string, keys: string): Promise<void> {
  const row = await findShortcutRow(window, label);
  const editBtn = row.getByRole("button", { name: /^Edit shortcut for/ });
  await expect(editBtn).toBeVisible({ timeout: T_SHORT });
  await editBtn.click();
  const recordPrompt = window.locator(SEL.settings.shortcutRecordPrompt);
  await expect(recordPrompt).toBeVisible({ timeout: T_SHORT });
  await recordPrompt.click();
  await window.keyboard.press(keys);

  // Save enables once the chord window closes and the combo is captured.
  const saveBtn = window
    .locator(SEL.settings.shortcutCancelButton)
    .locator("..")
    .locator("button", { hasText: "Save" });
  await expect(saveBtn).toBeEnabled({ timeout: T_MEDIUM });
  await saveBtn.click();
  await expect(recordPrompt).not.toBeVisible({ timeout: T_SHORT });
}

/** Every distinct value `probe` returned on any animation frame across `dwellMs`. */
async function valuesDuring(
  window: Page,
  probe: "layout" | "settings",
  dwellMs: number
): Promise<string[]> {
  return window.evaluate(
    ({ probe, dwellMs, sel }) =>
      new Promise<string[]>((resolve) => {
        const seen = new Set<string>();
        const start = performance.now();
        const sample = () => {
          seen.add(
            probe === "layout"
              ? `grid=${document.querySelectorAll(sel.grid).length} dock=${document.querySelectorAll(sel.dock).length}`
              : `settings=${document.querySelector(sel.settings) !== null}`
          );
          if (performance.now() - start >= dwellMs) return resolve([...seen]);
          requestAnimationFrame(sample);
        };
        sample();
      }),
    {
      probe,
      dwellMs,
      sel: {
        grid: SEL.panel.gridPanel,
        dock: SEL.panel.dockPanel,
        settings: SEL.settings.closeButton,
      },
    }
  );
}

/** Presses `keys` while sampling, so a change that lands during the press is seen too. */
async function valuesAcrossPress(
  window: Page,
  keys: string,
  probe: "layout" | "settings"
): Promise<string[]> {
  const sampled = valuesDuring(window, probe, NO_OP_DWELL_MS);
  await window.keyboard.press(keys);
  return sampled;
}

async function focusGridTerminal(window: Page): Promise<string> {
  const panel = window
    .locator(SEL.panel.gridPanel)
    .filter({ has: window.locator(SEL.terminal.xtermRows) })
    .first();
  const panelId = await panel.getAttribute("data-panel-id");
  expect(panelId, "grid terminal has no panel id").toBeTruthy();
  await panel.locator(SEL.terminal.xtermRows).click();
  await expectTerminalFocused(panel);
  return panelId!;
}

/** The old dock combo is dead while the rebound one moves the focused terminal to the dock. */
async function expectReboundToggleDock(window: Page): Promise<void> {
  const panelId = await focusGridTerminal(window);
  const grid = await getGridPanelCount(window);
  const dock = await getDockPanelCount(window);

  expect(
    await valuesAcrossPress(window, DEFAULT_TOGGLE_DOCK, "layout"),
    `${DEFAULT_TOGGLE_DOCK} still toggles the dock after the rebind`
  ).toEqual([`grid=${grid} dock=${dock}`]);

  await window.keyboard.press(REBOUND_TOGGLE_DOCK);
  await expect(window.locator(`${SEL.panel.dockPanel}[data-panel-id="${panelId}"]`)).toBeAttached({
    timeout: T_MEDIUM,
  });
  await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(grid - 1);
  await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(dock + 1);
}

/** With the toolbar focused, the default Settings combo no longer opens Settings. */
async function expectDefaultOpenSettingsDead(window: Page): Promise<void> {
  await window.locator(SEL.toolbar.projectSwitcherTrigger).focus();
  expect(
    await valuesAcrossPress(window, DEFAULT_OPEN_SETTINGS, "settings"),
    `${DEFAULT_OPEN_SETTINGS} still opens settings after the rebind`
  ).toEqual(["settings=false"]);
}

/**
 * One relaunch pair covers everything that has to survive a restart: the panel
 * layout, window bounds and collapsed sidebar, plus the theme, a notification
 * toggle and two rebound shortcuts — each fires in the session that recorded it,
 * its default combo goes dead, and both still hold after the relaunch.
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

  test("session 1: configure layout, window, theme, notifications and keybindings", async () => {
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
    // A third terminal so a grid terminal remains after the dock rebind moves one.
    await openTerminal(window);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(3);

    const firstGridPanel = window.locator(SEL.panel.gridPanel).first();
    await firstGridPanel.hover();
    await firstGridPanel.locator(SEL.panel.minimize).click();
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
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

    await recordShortcut(window, "Open settings", REBOUND_OPEN_SETTINGS);
    await recordShortcut(window, TOGGLE_DOCK_LABEL, REBOUND_TOGGLE_DOCK);

    await window.keyboard.press("Escape");
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

    // Both rebinds take effect in the running session and retire the defaults.
    await expectDefaultOpenSettingsDead(window);
    await window.keyboard.press(REBOUND_OPEN_SETTINGS);
    await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
    await window.locator(SEL.settings.closeButton).click();
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

    await expectReboundToggleDock(window);
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
    await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(2);

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

    // The rebound chord opens Settings in the relaunched app; the default stays dead.
    await expectDefaultOpenSettingsDead(window);
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
    const row = await findShortcutRow(window, "Open settings");
    // The reset button only renders while an override exists.
    await expect(row.locator(SEL.settings.shortcutResetButton)).toBeVisible({
      timeout: T_MEDIUM,
    });

    await window.locator(SEL.settings.closeButton).click();
    await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

    // Session 1 ended on the rebound dock move: one grid terminal, two docked.
    await expect.poll(() => getGridPanelCount(window), { timeout: T_MEDIUM }).toBe(1);
    await expect.poll(() => getDockPanelCount(window), { timeout: T_MEDIUM }).toBe(2);
    // The dock rebind was read back from disk at boot: the new combo works, the old stays dead.
    await expectReboundToggleDock(window);
  });
});
