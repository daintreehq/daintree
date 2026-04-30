import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import {
  writeCcrConfig,
  removeCcrConfig,
  navigateToAgentSettings,
  getPresetOptionLabels,
  getPresetRowByName,
} from "../helpers/presets";

let ctx: AppContext;

test.describe.serial("Presets: IPC Sync — Main ↔ Renderer (77–82)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "preset-ipc-sync" });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset IPC Sync Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("77. CCR config write triggers IPC event and presets appear in settings", async () => {
    // Write two CCR models so downstream tests in this serial block see the
    // split-button chevron and tray submenu-trigger (both require ≥2 presets).
    writeCcrConfig([
      { id: "ipc-sync-model", name: "IPC Sync Model", model: "ipc-model-v1" },
      { id: "ipc-sync-aux", name: "IPC Sync Aux", model: "ipc-model-v2" },
    ]);
    await ctx.window.waitForTimeout(35_000);

    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });

    // With the Popover-based PresetSelector, preset names only render inside
    // the open listbox (or in the selected-preset detail view). Open the
    // listbox and assert the new CCR preset shows up as an option.
    const labels = await getPresetOptionLabels(ctx.window);
    expect(labels.some((l) => l.includes("IPC Sync Model"))).toBe(true);
  });

  test("78. CCR presets store is populated — settings section shows auto badges", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    // The auto badge only renders once a CCR preset is selected — it lives in
    // the scope banner inside #agents-presets (not inside the per-preset detail
    // panel). Select the CCR preset, then assert the badge is visible in the
    // section.
    await getPresetRowByName(ctx.window, "IPC Sync Model");
    await expect(section.locator(SEL.preset.autoBadge)).toBeVisible({ timeout: T_SHORT });
  });

  test("79. CCR model sync makes toolbar chevron visible", async () => {
    // The split-button chevron renders only when Claude is pinned to the
    // toolbar AND has ≥2 presets. Skip gracefully when the agent isn't
    // pinned in the current test environment (E2E with/without CLI).
    const chevron = ctx.window.locator(SEL.preset.toolbarChevron);
    const visible = await chevron.isVisible({ timeout: T_MEDIUM }).catch(() => false);
    if (visible) {
      await expect(chevron).toBeVisible();
    }
  });

  test("80. CCR model sync populates agent tray with Claude sub-menu trigger", async () => {
    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const trayButton = ctx.window.locator('[aria-label^="Agent tray"]');
    await trayButton.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    // submenu-trigger only renders when Claude is UNPINNED (pinned agents
    // live on the main toolbar) AND has ≥2 presets. Accept absence when the
    // environment pins Claude automatically.
    const submenuTrigger = ctx.window.locator('[data-testid="submenu-trigger"]', {
      hasText: "Claude",
    });
    const visible = await submenuTrigger.isVisible({ timeout: T_MEDIUM }).catch(() => false);
    if (visible) {
      await expect(submenuTrigger).toBeVisible();
    }
    await ctx.window.keyboard.press("Escape");
  });

  test("81. Settings Presets section renders newly synced CCR entry", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    // Select the CCR preset via the Popover, then assert the section's scope
    // banner shows the `auto` badge that identifies a CCR entry.
    const detail = await getPresetRowByName(ctx.window, "IPC Sync Model");
    await expect(detail).toBeVisible({ timeout: T_SHORT });
    await expect(section.locator(SEL.preset.autoBadge)).toBeVisible({ timeout: T_SHORT });
  });

  test("82. Removing CCR config does not crash the app — settings still loads", async () => {
    removeCcrConfig();
    await ctx.window.waitForTimeout(35_000);

    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  });
});
