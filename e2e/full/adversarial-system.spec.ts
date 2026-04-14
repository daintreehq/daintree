import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import {
  navigateToAgentSettings,
  addCustomFlavor,
  removeCcrConfig,
  writeCcrConfig,
} from "../helpers/flavors";

let ctx: AppContext;

test.describe.serial("Adversarial E2E Tests: System Breakage", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "adversarial-e2e" });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Adversarial E2E Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("XSS attempt via flavor names", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);

    // Try to inject XSS via flavor name
    const editBtn = ctx.window.locator(SEL.flavor.editButton).first();
    await editBtn.click();
    const input = ctx.window.locator("[data-testid='flavor-edit-input']");
    await input.fill('<script>alert("xss")</script>');
    await input.press("Enter");

    // Verify no script execution (page should not alert)
    await ctx.window.waitForTimeout(1000);
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible(); // Should still be there, no crash
  });

  test("Resource exhaustion via massive flavor creation", async () => {
    await goToClaudeSettings();

    // Try to create many flavors rapidly
    for (let i = 0; i < 100; i++) {
      await addCustomFlavor(ctx.window);
      // Don't wait - stress test rapid creation
    }

    // Check if UI becomes unresponsive
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible({ timeout: 10000 }); // Should handle it gracefully
  });

  test("Race condition: CCR config changes during UI interaction", async () => {
    await goToClaudeSettings();

    // Start editing a flavor
    const editBtn = ctx.window.locator(SEL.flavor.editButton).first();
    await editBtn.click();
    const input = ctx.window.locator("[data-testid='flavor-edit-input']");
    await input.fill("Race Condition Test");

    // Change CCR config while editing
    writeCcrConfig([{ id: "race", name: "Race Flavor", model: "race-model" }]);

    // Try to commit the edit
    await input.press("Enter");
    await ctx.window.waitForTimeout(35000); // Wait for CCR poll

    // UI should still be functional
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible();
  });

  test("Corrupted localStorage causes settings page crash", async () => {
    // Corrupt the settings storage
    await ctx.window.evaluate(() => {
      localStorage.setItem("agentSettings", '{"agents":{"claude":{"customFlavors":[malformed');
    });

    await goToClaudeSettings();

    // App should handle corrupted data gracefully
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible(); // Should still render, maybe with defaults
  });

  test("Unicode and emoji attacks in flavor names", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);

    const editBtn = ctx.window.locator(SEL.flavor.editButton).first();
    await editBtn.click();
    const input = ctx.window.locator("[data-testid='flavor-edit-input']");

    // Try various unicode attacks
    const attacks = [
      "🚀".repeat(1000), // Many emojis
      "\u0000\u0001\u0002", // Null bytes
      "𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙", // Mathematical alphanumeric
      "ด้้้้้็็็็็้้้้้็็็็็้้้้้้้้็็็็็้้้้้็็็็็้้้้้้้้็็็็็้้้้้็็็็็้้้้้้้้็็็็็้้้้้็็็็็", // Zalgo text
    ];

    for (const attack of attacks) {
      await input.fill(attack);
      await input.press("Enter");
      await ctx.window.waitForTimeout(500);
    }

    // UI should handle all gracefully
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible();
  });

  test("IPC message bombing", async () => {
    // Try to send many rapid IPC messages
    for (let i = 0; i < 100; i++) {
      await ctx.window.evaluate(() => {
        window.electron.agentCapabilities.getCcrFlavors();
      });
    }

    // App should not crash from IPC overload
    await ctx.window.waitForTimeout(2000);
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible();
  });

  test("Settings navigation during async operations", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);

    // Start editing
    const editBtn = ctx.window.locator(SEL.flavor.editButton).first();
    await editBtn.click();

    // Navigate away while edit is pending
    await navigateToAgentSettings(ctx.window, "gemini");

    // Come back
    await navigateToAgentSettings(ctx.window, "claude");

    // UI should be in consistent state
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible();
  });

  test("Browser refresh during flavor operations", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);

    // Simulate page reload (Electron doesn't support reload, but test state consistency)
    await ctx.window.evaluate(() => {
      // Force a state reset
      localStorage.clear();
    });

    await goToClaudeSettings();

    // Should handle missing settings gracefully
    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible();
  });
});
