import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";

import { openSettings } from "../../helpers/panels";
let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

async function openKeyboardSettings(): Promise<void> {
  const { window } = ctx;
  const heading = window.locator(SEL.settings.heading);
  if (!(await heading.isVisible().catch(() => false))) {
    await openSettings(window);
  }
  await expect(heading).toBeVisible({ timeout: T_MEDIUM });

  await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "Keyboard" }).click();
  await expect(window.locator("h3", { hasText: "Keyboard Shortcuts" })).toBeVisible({
    timeout: T_SHORT,
  });
}

test.describe.serial("Core: Settings Advanced", () => {
  test.beforeAll(async () => {
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "settings-advanced" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Settings Advanced Test"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // ── Keyboard Shortcuts (5 tests) ──────────────────────────

  test.describe.serial("Keyboard Shortcuts", () => {
    test("open settings and navigate to Keyboard tab", async () => {
      await openKeyboardSettings();
    });

    test("shortcut list renders with search input and rows", async () => {
      const { window } = ctx;
      await openKeyboardSettings();
      await expect(window.locator(SEL.settings.shortcutsSearchInput)).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.locator(SEL.settings.shortcutResetAllButton).first()).toBeVisible({
        timeout: T_SHORT,
      });

      const rows = window.locator(SEL.settings.shortcutRow);
      await expect(rows.first()).toBeVisible({ timeout: T_SHORT });
      expect(await rows.count()).toBeGreaterThan(0);
    });

    test("search filters shortcut rows", async () => {
      const { window } = ctx;
      await openKeyboardSettings();
      const searchInput = window.locator(SEL.settings.shortcutsSearchInput);

      await searchInput.fill("Open settings");
      await window.waitForTimeout(T_SETTLE);

      const rows = window.locator(SEL.settings.shortcutRow);
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
      await openKeyboardSettings();

      const searchInput = window.locator(SEL.settings.shortcutsSearchInput);
      await searchInput.fill("Open settings");
      await window.waitForTimeout(T_SETTLE);

      const row = window.locator(SEL.settings.shortcutRow).first();
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
      await openKeyboardSettings();

      const searchInput = window.locator(SEL.settings.shortcutsSearchInput);
      await searchInput.fill("Open settings");
      await window.waitForTimeout(T_SETTLE);

      const row = window.locator(SEL.settings.shortcutRow).first();
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

    test("recording a combo bound elsewhere shows a conflict warning", async () => {
      const { window } = ctx;
      await openKeyboardSettings();

      // Edit a shortcut that is NOT bound to Cmd+T, then record Cmd+T —
      // the default binding for "Duplicate focused panel" (terminal.duplicate).
      // Conflict detection (which excludes the action being edited) must flag it.
      const searchInput = window.locator(SEL.settings.shortcutsSearchInput);
      await searchInput.fill("Reopen last");
      await window.waitForTimeout(T_SETTLE);

      const row = window.locator(SEL.settings.shortcutRow).first();
      await row.scrollIntoViewIfNeeded();
      await row.hover();

      const editBtn = row.locator("button", { hasText: "Edit" });
      await expect(editBtn).toBeVisible({ timeout: T_SHORT });
      await editBtn.click();

      const recordPrompt = window.locator(SEL.settings.shortcutRecordPrompt);
      await expect(recordPrompt).toBeVisible({ timeout: T_SHORT });
      await recordPrompt.click();

      // The recorder reads event.code; Cmd maps to Meta on macOS, Ctrl elsewhere.
      const combo = process.platform === "darwin" ? "Meta+KeyT" : "Control+KeyT";
      await window.keyboard.press(combo);

      // Wait out the chord timeout (1s) so recording finalizes.
      await window.waitForTimeout(1500);

      await expect(window.locator(SEL.settings.shortcutConflictWarning)).toBeVisible({
        timeout: T_SHORT,
      });
      // The conflict names the action that owns Cmd+T.
      await expect(window.locator("text=Duplicate focused panel")).toBeVisible({
        timeout: T_SHORT,
      });

      // Cancel without saving — leaves all bindings untouched.
      await window.locator(SEL.settings.shortcutCancelButton).click();
      await expect(recordPrompt).not.toBeVisible({ timeout: T_SHORT });

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

  // ── Notification Sound Preview ────────────────────────────
  // The Preview button calls window.electron.notification.playSound, which
  // plays real audio in the main process. contextBridge objects are frozen,
  // so the renderer can't spy on it — intercept the IPC handler in the main
  // process instead, which both suppresses audio and captures the call.

  test.describe.serial("Notification sound preview", () => {
    test.beforeAll(async () => {
      await ctx.app.evaluate(({ ipcMain }) => {
        const channel = "notification:play-sound";
        const globals = globalThis as unknown as Record<string, unknown>;
        globals.__e2ePlaySoundFile = null;
        // removeHandler before handle — Electron throws on a double registration.
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (_event: unknown, soundFile: unknown) => {
          globals.__e2ePlaySoundFile = soundFile;
          return null;
        });
      });
    });

    test.afterAll(async () => {
      // Restore a no-op handler rather than leaving the channel unhandled:
      // the real production handler was already removed in beforeAll, and an
      // unhandled invoke would throw for any later test that plays a sound.
      await ctx.app.evaluate(({ ipcMain }) => {
        const channel = "notification:play-sound";
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => null);
      });
    });

    test("clicking Preview invokes playSound with the selected sound file", async () => {
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

      // The sound section (and its Preview buttons) only render when the sound
      // toggle is on — enable it if a prior run left it off.
      const soundToggle = window.locator(SEL.settings.notifSoundToggle);
      await expect(soundToggle).toBeVisible({ timeout: T_SHORT });
      if ((await soundToggle.getAttribute("aria-checked")) === "false") {
        await soundToggle.click();
      }

      const previewButton = window.locator(SEL.settings.soundPreviewButton).first();
      await expect(previewButton).toBeVisible({ timeout: T_SHORT });
      await previewButton.click();

      // The intercepted IPC handler recorded the requested sound file — no
      // real audio was emitted.
      await expect
        .poll(
          async () => {
            const file = await ctx.app.evaluate(
              () => (globalThis as unknown as Record<string, unknown>).__e2ePlaySoundFile
            );
            return typeof file === "string" && file.endsWith(".wav");
          },
          { timeout: T_MEDIUM }
        )
        .toBe(true);

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── MCP Server empty state + enable flow ──────────────────

  test.describe.serial("MCP server", () => {
    test("empty state, enable reveals Connection, then disable", async () => {
      const { window } = ctx;
      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      await window.locator(`${SEL.settings.navSidebar} button`, { hasText: "MCP Server" }).click();

      const emptyState = window.locator(SEL.settings.mcpServerEmptyState);
      const connectionMarker = window.locator(SEL.settings.mcpConnectionMarker);

      // Wait for the initial status load to settle (either state is fine).
      await expect(emptyState.or(connectionMarker).first()).toBeVisible({ timeout: T_MEDIUM });

      // Normalize to disabled so we can assert the empty state.
      if (await connectionMarker.isVisible().catch(() => false)) {
        await window.locator(SEL.settings.mcpServerToggle).click();
        // A disable-confirm dialog only appears when external clients are
        // connected (none in E2E), but handle it defensively.
        const stopButton = window.getByRole("button", { name: "Stop sharing" });
        if (await stopButton.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          await stopButton.click();
        }
        await expect(emptyState).toBeVisible({ timeout: T_MEDIUM });
      }

      await expect(emptyState).toBeVisible({ timeout: T_SHORT });

      // Enable via the empty-state CTA → the Connection section appears.
      await window.locator(SEL.settings.mcpServerEnableButton).click();
      await expect(connectionMarker).toBeVisible({ timeout: T_MEDIUM });
      await expect(emptyState).not.toBeVisible({ timeout: T_SHORT });
      // The "Running on port" line only renders once the server actually binds,
      // proving the enable path started the server (not just flipped a flag).
      await expect(window.locator("text=Running on port")).toBeVisible({ timeout: T_MEDIUM });

      // Cleanup — turn the server back off so the bound port is released.
      await window.locator(SEL.settings.mcpServerToggle).click();
      const stopButton = window.getByRole("button", { name: "Stop sharing" });
      if (await stopButton.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await stopButton.click();
      }
      await expect(emptyState).toBeVisible({ timeout: T_MEDIUM });

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  // ── Settings scope filtering + search navigation ──────────

  test.describe.serial("Settings scope and search navigation", () => {
    test("scope toggle filters nav tabs and remembers the per-scope tab", async () => {
      const { window } = ctx;
      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      const nav = window.locator(SEL.settings.navSidebar);

      // Global scope shows global tabs, not project-only ones.
      await expect(nav.locator("button", { hasText: "Appearance" })).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(nav.locator("button", { hasText: "Variables" })).toHaveCount(0);

      // Switch to Project scope (Radix Select) → nav swaps to project tabs.
      await window.locator(SEL.settings.scopeSelect).click();
      await window.locator('[role="option"]', { hasText: "Project" }).click();
      await expect(window.locator('[role="listbox"]')).toHaveCount(0, { timeout: T_SHORT });

      await expect(nav.locator("button", { hasText: "Variables" })).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(nav.locator("button", { hasText: "Appearance" })).toHaveCount(0);

      // Navigate to a project tab so it becomes the remembered project tab.
      await nav.locator("button", { hasText: "Variables" }).click();
      await expect(window.locator("h3", { hasText: "Environment Variables" })).toBeVisible({
        timeout: T_SHORT,
      });

      // Flip to Global and back — the project scope restores its remembered tab.
      await window.locator(SEL.settings.scopeSelect).click();
      await window.locator('[role="option"]', { hasText: "Global" }).click();
      await expect(window.locator('[role="listbox"]')).toHaveCount(0, { timeout: T_SHORT });
      await expect(nav.locator("button", { hasText: "Appearance" })).toBeVisible({
        timeout: T_SHORT,
      });

      await window.locator(SEL.settings.scopeSelect).click();
      await window.locator('[role="option"]', { hasText: "Project" }).click();
      await expect(window.locator('[role="listbox"]')).toHaveCount(0, { timeout: T_SHORT });
      await expect(window.locator("h3", { hasText: "Environment Variables" })).toBeVisible({
        timeout: T_SHORT,
      });

      // Restore global scope before closing so later state is predictable.
      await window.locator(SEL.settings.scopeSelect).click();
      await window.locator('[role="option"]', { hasText: "Global" }).click();
      await expect(window.locator('[role="listbox"]')).toHaveCount(0, { timeout: T_SHORT });

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });

    test("search results navigate to the right tab via keyboard and click", async () => {
      const { window } = ctx;
      await openSettings(window);
      await expect(window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });

      const searchInput = window.locator(SEL.settings.searchInput);

      // Keyboard navigation: ArrowDown selects the first result, Enter opens it.
      await searchInput.fill("font size");
      await window.waitForTimeout(T_SETTLE);
      await expect(window.locator("h3", { hasText: "Search Results" })).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.locator(SEL.settings.searchResultsRegion)).toBeVisible({
        timeout: T_SHORT,
      });

      await searchInput.press("ArrowDown");
      await searchInput.press("Enter");

      // Landed on the Appearance tab (the first "font size" result) and search cleared.
      await expect(window.locator("h3", { hasText: "Appearance" })).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(searchInput).toHaveValue("");

      // Click navigation: clicking a result also lands on its tab.
      await searchInput.fill("font size");
      await window.waitForTimeout(T_SETTLE);
      const firstResult = window
        .locator(SEL.settings.searchResultsRegion)
        .locator("button")
        .first();
      await expect(firstResult).toBeVisible({ timeout: T_SHORT });
      await firstResult.click();
      await expect(window.locator("h3", { hasText: "Search Results" })).not.toBeVisible({
        timeout: T_SHORT,
      });
      await expect(window.locator("h3", { hasText: "Appearance" })).toBeVisible({
        timeout: T_SHORT,
      });
      await expect(searchInput).toHaveValue("");

      await window.keyboard.press("Escape");
      await expect(window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_SHORT });
    });
  });
});
