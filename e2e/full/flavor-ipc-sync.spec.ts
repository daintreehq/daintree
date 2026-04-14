import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import { writeCcrConfig, removeCcrConfig, navigateToAgentSettings } from "../helpers/flavors";

let ctx: AppContext;

test.describe.serial("Flavors: IPC Sync — Main ↔ Renderer (77–82)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "flavor-ipc-sync" });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Flavor IPC Sync Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("77. CCR config write triggers IPC event and flavors appear in settings", async () => {
    writeCcrConfig([{ id: "ipc-sync-model", name: "IPC Sync Model", model: "ipc-model-v1" }]);
    await ctx.window.waitForTimeout(35_000);

    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.flavor.section)).toBeVisible({ timeout: T_MEDIUM });
    await expect(
      ctx.window.locator(SEL.flavor.section).locator("span", { hasText: "IPC Sync Model" }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("78. CCR flavors store is populated — settings section shows auto badges", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    const autoBadges = section.locator(SEL.flavor.autoBadge);
    await expect(autoBadges.first()).toBeVisible({ timeout: T_SHORT });
    const count = await autoBadges.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("79. CCR model sync makes toolbar chevron visible", async () => {
    const chevron = ctx.window.locator(SEL.flavor.toolbarChevron);
    await expect(chevron).toBeVisible({ timeout: T_MEDIUM });
  });

  test("80. CCR model sync populates agent tray with Claude sub-menu trigger", async () => {
    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const trayButton = ctx.window.locator('[aria-label="Agent tray"]');
    await trayButton.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const submenuTrigger = ctx.window.locator('[data-testid="submenu-trigger"]', {
      hasText: "Claude",
    });
    await expect(submenuTrigger).toBeVisible({ timeout: T_MEDIUM });
  });

  test("81. Settings Flavors section renders newly synced CCR entry", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    const row = section.locator("div.flex.items-center.border", {
      hasText: "IPC Sync Model",
    });
    await expect(row).toBeVisible({ timeout: T_SHORT });
    await expect(row.locator(SEL.flavor.autoBadge)).toBeVisible({ timeout: T_SHORT });
  });

  test("82. Removing CCR config does not crash the app — settings still loads", async () => {
    removeCcrConfig();
    await ctx.window.waitForTimeout(35_000);

    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  });
});
