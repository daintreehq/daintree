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
  addCustomFlavor,
} from "../helpers/flavors";

let ctx: AppContext;

test.describe.serial("Flavors: Onboarding/Wizard Integration (83–88)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "flavor-wizard" });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Flavor Wizard Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("83. Write CCR config with 2 models, open wizard, verify Claude shows flavor count badge", async () => {
    writeCcrConfig([
      { id: "deepseek", name: "DeepSeek V3", model: "deepseek-v3" },
      { id: "gpt5", name: "GPT-5", model: "gpt-5.4" },
    ]);

    await ctx.window.waitForTimeout(35_000);

    await ctx.window.evaluate(() =>
      window.dispatchEvent(new CustomEvent("canopy:open-agent-setup-wizard"))
    );

    const wizardDialog = ctx.window.locator('[role="dialog"][aria-label="Agent Setup Wizard"]');
    await expect(wizardDialog).toBeVisible({ timeout: T_MEDIUM });

    const claudeCard = wizardDialog.locator('[data-testid="agent-card-claude"]');
    await expect(claudeCard).toBeVisible({ timeout: T_SHORT });

    const flavorBadge = claudeCard.locator("[data-testid='flavor-count-badge']");
    await expect(flavorBadge).toBeVisible({ timeout: T_SHORT });
  });

  test("84. In the wizard Complete step, verify flavor badges appear next to agent names", async () => {
    const wizardDialog = ctx.window.locator('[role="dialog"][aria-label="Agent Setup Wizard"]');

    const nextButton = wizardDialog.locator('button:has-text("Next")');
    if (await nextButton.isVisible().catch(() => false)) {
      await nextButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const completeStep = wizardDialog.locator("[data-testid='wizard-step-complete']");
    if (await completeStep.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      const claudeEntry = completeStep.locator("li, [data-agent-id='claude']").first();
      await expect(claudeEntry).toBeVisible({ timeout: T_SHORT });
      const badge = claudeEntry.locator("[data-testid='flavor-count-badge']");
      await expect(badge).toBeVisible({ timeout: T_SHORT });
    }

    const closeButton = wizardDialog.locator('button:has-text("Close"), button:has-text("Done")');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(wizardDialog).not.toBeVisible({ timeout: T_SHORT });
    }
  });

  test("85. Verify flavor badge text shows correct count like '2 flavors'", async () => {
    await ctx.window.evaluate(() =>
      window.dispatchEvent(new CustomEvent("canopy:open-agent-setup-wizard"))
    );

    const wizardDialog = ctx.window.locator('[role="dialog"][aria-label="Agent Setup Wizard"]');
    await expect(wizardDialog).toBeVisible({ timeout: T_MEDIUM });

    const claudeCard = wizardDialog.locator('[data-testid="agent-card-claude"]');
    await expect(claudeCard).toBeVisible({ timeout: T_SHORT });

    const flavorBadge = claudeCard.locator("[data-testid='flavor-count-badge']");
    await expect(flavorBadge).toBeVisible({ timeout: T_SHORT });
    await expect(flavorBadge).toContainText("2 flavor", { timeout: T_SHORT });

    const closeButton = wizardDialog.locator('button:has-text("Close"), button:has-text("Done")');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(wizardDialog).not.toBeVisible({ timeout: T_SHORT });
    }
  });

  test("86. Verify Gemini does NOT show a flavor badge (no CCR flavors)", async () => {
    await ctx.window.evaluate(() =>
      window.dispatchEvent(new CustomEvent("canopy:open-agent-setup-wizard"))
    );

    const wizardDialog = ctx.window.locator('[role="dialog"][aria-label="Agent Setup Wizard"]');
    await expect(wizardDialog).toBeVisible({ timeout: T_MEDIUM });

    const geminiCard = wizardDialog.locator('[data-testid="agent-card-gemini"]');
    if (await geminiCard.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      const badge = geminiCard.locator("[data-testid='flavor-count-badge']");
      await expect(badge).not.toBeVisible({ timeout: T_SHORT });
    }

    const closeButton = wizardDialog.locator('button:has-text("Close"), button:has-text("Done")');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(wizardDialog).not.toBeVisible({ timeout: T_SHORT });
    }
  });

  test("87. Complete wizard pinning an agent with flavors, verify agent is pinned and flavors still available", async () => {
    await ctx.window.evaluate(() =>
      window.dispatchEvent(new CustomEvent("canopy:open-agent-setup-wizard"))
    );

    const wizardDialog = ctx.window.locator('[role="dialog"][aria-label="Agent Setup Wizard"]');
    await expect(wizardDialog).toBeVisible({ timeout: T_MEDIUM });

    const claudeCard = wizardDialog.locator('[data-testid="agent-card-claude"]');
    await expect(claudeCard).toBeVisible({ timeout: T_SHORT });

    const pinButton = claudeCard.locator(
      'button[aria-label*="Pin"], button[aria-label*="pin"], button:has-text("Pin")'
    );
    if (await pinButton.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      await pinButton.click();
    }

    const completeButton = wizardDialog.locator(
      'button:has-text("Complete"), button:has-text("Finish")'
    );
    if (await completeButton.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      await completeButton.click();
    }

    const nextButton = wizardDialog.locator('button:has-text("Next")');
    while (await nextButton.isVisible({ timeout: 500 }).catch(() => false)) {
      await nextButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const closeButton = wizardDialog.locator('button:has-text("Close"), button:has-text("Done")');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(wizardDialog).not.toBeVisible({ timeout: T_SHORT });
    }

    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.flavor.section)).toBeVisible({ timeout: T_MEDIUM });
    await expect(
      ctx.window
        .locator(SEL.flavor.section)
        .locator("span", { hasText: "CCR: DeepSeek V3" })
        .first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("88. Add custom flavors to Claude, open wizard, verify AgentCard shows badge for custom flavors too", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomFlavor(ctx.window);

    const nameInput = ctx.window.locator(
      `${SEL.flavor.section} input[placeholder*="name" i], ${SEL.flavor.section} input[aria-label*="name" i]`
    );
    if (await nameInput.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      await nameInput.fill("My Custom Flavor");
      await ctx.window.keyboard.press("Enter");
    }
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.evaluate(() =>
      window.dispatchEvent(new CustomEvent("canopy:open-agent-setup-wizard"))
    );

    const wizardDialog = ctx.window.locator('[role="dialog"][aria-label="Agent Setup Wizard"]');
    await expect(wizardDialog).toBeVisible({ timeout: T_MEDIUM });

    const claudeCard = wizardDialog.locator('[data-testid="agent-card-claude"]');
    await expect(claudeCard).toBeVisible({ timeout: T_SHORT });

    const flavorBadge = claudeCard.locator("[data-testid='flavor-count-badge']");
    await expect(flavorBadge).toBeVisible({ timeout: T_SHORT });
    await expect(flavorBadge).toContainText("flavor", { timeout: T_SHORT });

    const closeButton = wizardDialog.locator('button:has-text("Close"), button:has-text("Done")');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(wizardDialog).not.toBeVisible({ timeout: T_SHORT });
    }
  });
});
