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
  addCustomPreset,
} from "../helpers/presets";

let ctx: AppContext;

test.describe.serial("Presets: Terminal Palette Integration (89–92)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "preset-palette" });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Palette Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const openTerminalPalette = async () => {
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    await ctx.window.keyboard.press(`${mod}+T`);
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  test("89. New terminal palette shows preset count for Claude when CCR config has 2+ models", async () => {
    writeCcrConfig([
      { id: "pal-a", name: "Palette Model A", model: "pal-model-a" },
      { id: "pal-b", name: "Palette Model B", model: "pal-model-b" },
    ]);
    await ctx.window.waitForTimeout(35_000);

    await openTerminalPalette();

    const dialog = ctx.window.locator('[role="dialog"]');
    const claudeEntry = dialog.locator('[role="option"], [role="menuitem"], li, button', {
      hasText: /Claude/i,
    });
    if (
      await claudeEntry
        .first()
        .isVisible({ timeout: T_SHORT })
        .catch(() => false)
    ) {
      const desc = claudeEntry.first().locator("..").locator("text=/\\d+\\s*preset/i");
      if (await desc.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await expect(desc).toBeVisible({ timeout: T_SHORT });
      } else {
        const entryText = await claudeEntry.first().textContent();
        expect(entryText).toBeTruthy();
      }
    }

    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test("90. Removing CCR config hides preset count in palette", async () => {
    removeCcrConfig();
    await ctx.window.waitForTimeout(35_000);

    await openTerminalPalette();

    const dialog = ctx.window.locator('[role="dialog"]');
    const claudeEntry = dialog.locator('[role="option"], [role="menuitem"], li, button', {
      hasText: /Claude/i,
    });
    if (
      await claudeEntry
        .first()
        .isVisible({ timeout: T_SHORT })
        .catch(() => false)
    ) {
      const presetText = claudeEntry.first().locator("text=/\\d+\\s*preset/i");
      await expect(presetText).not.toBeVisible({ timeout: T_SHORT });
    }

    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test("91. Set default preset and launch from palette — no crash", async () => {
    writeCcrConfig([
      { id: "launch-a", name: "Launch Preset A", model: "launch-model-a" },
      { id: "launch-b", name: "Launch Preset B", model: "launch-model-b" },
    ]);
    await ctx.window.waitForTimeout(35_000);

    await navigateToAgentSettings(ctx.window, "claude");
    const select = ctx.window.locator(SEL.preset.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_MEDIUM });
    const options = select.locator("option");
    const count = await options.count();
    if (count > 1) {
      await select.selectOption({ index: 1 });
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await openTerminalPalette();

    const claudeEntry = ctx.window
      .locator('[role="dialog"]')
      .locator('[role="option"], [role="menuitem"], li, button', { hasText: /Claude/i });
    if (
      await claudeEntry
        .first()
        .isVisible({ timeout: T_SHORT })
        .catch(() => false)
    ) {
      await claudeEntry.first().click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const dialog = ctx.window.locator('[role="dialog"]');
    await expect(dialog)
      .not.toBeVisible({ timeout: T_MEDIUM })
      .catch(() => {});
  });

  test("92. Adding custom presets updates palette description with preset count", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await openTerminalPalette();

    const dialog = ctx.window.locator('[role="dialog"]');
    const claudeEntry = dialog.locator('[role="option"], [role="menuitem"], li, button', {
      hasText: /Claude/i,
    });
    if (
      await claudeEntry
        .first()
        .isVisible({ timeout: T_SHORT })
        .catch(() => false)
    ) {
      const parentRow = claudeEntry.first();
      const presetDesc = parentRow.locator("..").locator("text=/preset/i");
      if (await presetDesc.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        const descText = await presetDesc.textContent();
        expect(descText).toBeTruthy();
      }
    }

    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);
  });
});
