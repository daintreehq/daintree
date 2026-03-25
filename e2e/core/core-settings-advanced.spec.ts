import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";

import { openSettings } from "../helpers/panels";
let ctx: AppContext;

test.describe.serial("Core: Settings Advanced", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "settings-advanced" });
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Settings Advanced Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  // ── Keyboard Shortcuts (5 tests) ──────────────────────────

  test.describe.serial("Keyboard Shortcuts", () => {
    test("open settings and navigate to Keyboard tab", async () => {
      const { window } = ctx;
      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Keyboard" }).click();
      await expect(window.locator("h3", { hasText: "Keyboard Shortcuts" })).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("shortcut list renders with search input and rows", async () => {
      const { window } = ctx;
      await expect(window.locator(SEL.settings.shortcutsSearchInput)).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.locator(SEL.settings.shortcutResetAllButton).first()).toBeVisible({
        timeout: T_SHORT,
      });

      const rows = window.locator(".group").filter({
        has: window.locator("button", { hasText: "Edit" }),
      });
      await expect(rows.first()).toBeVisible({ timeout: T_SHORT });
      expect(await rows.count()).toBeGreaterThan(0);
    });

    test("search filters shortcut rows", async () => {
      const { window } = ctx;
      const searchInput = window.locator(SEL.settings.shortcutsSearchInput);

      await searchInput.fill("Open settings");
      await window.waitForTimeout(T_SETTLE);

      const rows = window.locator(".group").filter({
        has: window.locator("button", { hasText: "Edit" }),
      });
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);

      const firstRowText = await rows.first().textContent();
      expect(firstRowText?.toLowerCase()).toContain("open settings");

      await searchInput.fill("");
      await window.waitForTimeout(T_SETTLE);

      const allCount = await rows.count();
      expect(allCount).toBeGreaterThan(count);
    });

    test("click Edit enters edit mode, Cancel exits it", async () => {
      const { window } = ctx;

      const searchInput = window.locator(SEL.settings.shortcutsSearchInput);
      await searchInput.fill("Open settings");
      await window.waitForTimeout(T_SETTLE);

      const row = window
        .locator(".group")
        .filter({
          has: window.locator("button", { hasText: "Edit" }),
        })
        .first();
      await row.scrollIntoViewIfNeeded();
      await row.hover();

      const editBtn = row.locator("button", { hasText: "Edit" });
      await expect(editBtn).toBeVisible({ timeout: T_SHORT });
      await editBtn.click();

      const recordPrompt = window.locator(SEL.settings.shortcutRecordPrompt);
      await expect(recordPrompt).toBeVisible({ timeout: T_SHORT });

      const cancelBtn = window.locator(SEL.settings.shortcutCancelButton);
      await cancelBtn.click();
      await expect(recordPrompt).not.toBeVisible({ timeout: T_SHORT });

      await searchInput.fill("");
      await window.waitForTimeout(T_SETTLE);

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });

    test("per-shortcut reset button restores default binding", async () => {
      const { window } = ctx;

      // Open settings and navigate to Keyboard tab
      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Keyboard" }).click();
      await expect(window.locator("h3", { hasText: "Keyboard Shortcuts" })).toBeVisible({
        timeout: T_SHORT,
      });

      const searchInput = window.locator(SEL.settings.shortcutsSearchInput);
      await searchInput.fill("Open settings");
      await window.waitForTimeout(T_SETTLE);

      const row = window
        .locator(".group")
        .filter({
          has: window.locator("button", { hasText: "Edit" }),
        })
        .first();
      await row.scrollIntoViewIfNeeded();
      await row.hover();

      // Use the Edit UI to create an override via recording
      const editBtn = row.locator("button", { hasText: "Edit" });
      await expect(editBtn).toBeVisible({ timeout: T_SHORT });
      await editBtn.click();

      // Click "Click to record shortcut" to start recording
      const recordPrompt = window.locator(SEL.settings.shortcutRecordPrompt);
      await expect(recordPrompt).toBeVisible({ timeout: T_SHORT });
      await recordPrompt.click();

      // Press a key combo
      await window.keyboard.press("Control+Shift+KeyZ");

      // Wait for chord timeout (1s) + settle for recording to finish
      await window.waitForTimeout(1500);

      // Click Save — it's inside the KeyRecorder, sibling of the recorder Cancel button
      const recorderArea = window.locator(SEL.settings.shortcutCancelButton).locator("..");
      const saveBtn = recorderArea.locator("button", { hasText: "Save" });
      await expect(saveBtn).toBeVisible({ timeout: T_SHORT });
      await saveBtn.click();

      // Wait for the recorder to close
      await window.waitForTimeout(T_SETTLE);

      // Now hover the row again to see the reset button
      await row.scrollIntoViewIfNeeded();
      await row.hover();

      const resetBtn = row.locator(SEL.settings.shortcutResetButton);
      await expect(resetBtn).toBeVisible({ timeout: T_MEDIUM });
      await resetBtn.click();

      await row.hover();
      await expect(resetBtn).not.toBeVisible({ timeout: T_SHORT });

      await searchInput.fill("");
      await window.waitForTimeout(T_SETTLE);

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Notification Settings (3 tests) ───────────────────────

  test.describe.serial("Notification Settings", () => {
    test("open settings and navigate to Notifications tab — checkboxes visible", async () => {
      const { window } = ctx;
      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      await window
        .locator(`${SEL.settings.navSidebar} button`, { hasText: "Notifications" })
        .click();
      await expect(window.locator("h3", { hasText: "Notifications" })).toBeVisible({
        timeout: T_SHORT,
      });

      await expect(window.locator("text=Loading…")).not.toBeVisible({ timeout: T_MEDIUM });

      await expect(window.locator(SEL.settings.notifCompletedCheckbox)).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.locator(SEL.settings.notifWaitingCheckbox)).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.locator(SEL.settings.notifSoundToggle)).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("toggle notification checkbox and verify persistence", async () => {
      const { window } = ctx;

      const checkbox = window.locator(SEL.settings.notifCompletedCheckbox);
      await expect(checkbox).not.toBeChecked({ timeout: T_SHORT });

      await checkbox.click();
      await expect(checkbox).toBeChecked({ timeout: T_SHORT });

      await expect
        .poll(
          async () => {
            const settings = await window.evaluate(() =>
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (window as unknown as Record<string, any>).electron?.notification?.getSettings()
            );
            return settings?.completedEnabled;
          },
          { timeout: T_MEDIUM }
        )
        .toBe(true);

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });

      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      await window
        .locator(`${SEL.settings.navSidebar} button`, { hasText: "Notifications" })
        .click();
      await expect(window.locator("text=Loading…")).not.toBeVisible({ timeout: T_MEDIUM });

      await expect(checkbox).toBeChecked({ timeout: T_SHORT });
    });

    test("cleanup — uncheck notification checkbox", async () => {
      const { window } = ctx;

      const checkbox = window.locator(SEL.settings.notifCompletedCheckbox);
      await expect(checkbox).toBeChecked({ timeout: T_SHORT });

      await checkbox.click();
      await expect(checkbox).not.toBeChecked({ timeout: T_SHORT });

      await expect
        .poll(
          async () => {
            const settings = await window.evaluate(() =>
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (window as unknown as Record<string, any>).electron?.notification?.getSettings()
            );
            return settings?.completedEnabled;
          },
          { timeout: T_MEDIUM }
        )
        .toBe(false);

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });
  });
});
