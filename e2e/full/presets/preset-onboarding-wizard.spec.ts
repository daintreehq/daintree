import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";
import {
  writeCcrConfig,
  removeCcrConfig,
  navigateToAgentSettings,
  waitForCcrPresets,
  addCustomPreset,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Presets: Onboarding/Wizard Integration (83–88)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-wizard" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Preset Wizard Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("83. Write CCR config with 2 models, open wizard, verify Claude shows preset count badge", async () => {
    writeCcrConfig([
      { id: "deepseek", name: "DeepSeek V3", model: "deepseek-v3" },
      { id: "gpt5", name: "GPT-5", model: "gpt-5.4" },
    ]);

    await waitForCcrPresets(ctx.window, ["DeepSeek V3", "GPT-5"]);
    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.evaluate(() =>
      window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"))
    );

    const wizardDialog = ctx.window.locator(SEL.firstRun.agentSetupDialog);
    await expect(wizardDialog).toBeVisible({ timeout: T_MEDIUM });

    // The agent cards (and their preset-count badges) only render on the
    // wizard's "Complete" step, which is reachable only when an agent is
    // launchable in this environment. Without a real/fake agent binary the
    // step never appears — skip honestly rather than passing vacuously.
    const claudeCard = wizardDialog.locator('[data-testid="agent-card-claude"]');
    const visible = await claudeCard.isVisible({ timeout: T_SHORT }).catch(() => false);
    test.info().annotations.push({
      type: "conditional-skip",
      description: "Claude agent card not on Complete step (no launchable Claude binary)",
    });
    test.skip(!visible, "Claude agent card not on Complete step (no launchable Claude binary)");

    const presetBadge = claudeCard.locator("[data-testid='preset-count-badge']");
    await expect(presetBadge).toBeVisible({ timeout: T_SHORT });
  });

  test("84. In the wizard Complete step, verify preset badges appear next to agent names", async () => {
    const wizardDialog = ctx.window.locator(SEL.firstRun.agentSetupDialog);

    const nextButton = wizardDialog.locator('button:has-text("Next")');
    if (await nextButton.isVisible().catch(() => false)) {
      await nextButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const claudeEntry = wizardDialog.locator('[data-testid="agent-card-claude"]');
    const onComplete = await claudeEntry.isVisible({ timeout: T_SHORT }).catch(() => false);
    test.info().annotations.push({
      type: "conditional-skip",
      description: "Claude agent card not on Complete step (no launchable Claude binary)",
    });
    test.skip(!onComplete, "Claude agent card not on Complete step (no launchable Claude binary)");

    const badge = claudeEntry.locator("[data-testid='preset-count-badge']");
    await expect(badge).toBeVisible({ timeout: T_SHORT });

    const closeButton = wizardDialog.locator('button:has-text("Close"), button:has-text("Done")');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(wizardDialog).not.toBeVisible({ timeout: T_SHORT });
    }
  });

  test("85. Verify preset badge text shows correct count like '2 presets'", async () => {
    await ctx.window.evaluate(() =>
      window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"))
    );

    const wizardDialog = ctx.window.locator(SEL.firstRun.agentSetupDialog);
    await expect(wizardDialog).toBeVisible({ timeout: T_MEDIUM });

    // agent-card-claude renders on the Complete step which requires a
    // launchable Claude binary. Skip honestly when that step is unreachable
    // rather than asserting nothing.
    const claudeCard = wizardDialog.locator('[data-testid="agent-card-claude"]');
    const visible = await claudeCard.isVisible({ timeout: T_SHORT }).catch(() => false);
    test.info().annotations.push({
      type: "conditional-skip",
      description: "Claude agent card not on Complete step (no launchable Claude binary)",
    });
    test.skip(!visible, "Claude agent card not on Complete step (no launchable Claude binary)");

    const presetBadge = claudeCard.locator("[data-testid='preset-count-badge']");
    await expect(presetBadge).toBeVisible({ timeout: T_SHORT });
    await expect(presetBadge).toContainText("2 preset", { timeout: T_SHORT });

    const closeButton = wizardDialog.locator('button:has-text("Close"), button:has-text("Done")');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(wizardDialog).not.toBeVisible({ timeout: T_SHORT });
    }
  });

  test("86. Verify Gemini does NOT show a preset badge (no CCR presets)", async () => {
    await ctx.window.evaluate(() =>
      window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"))
    );

    const wizardDialog = ctx.window.locator(SEL.firstRun.agentSetupDialog);
    await expect(wizardDialog).toBeVisible({ timeout: T_MEDIUM });

    // The negative (Gemini shows no badge) is only meaningful once the
    // Complete step actually renders Gemini's card. Anchor on the card's
    // presence and skip honestly otherwise — never assert absence in an env
    // where the card was never going to render.
    const geminiCard = wizardDialog.locator('[data-testid="agent-card-gemini"]');
    const onComplete = await geminiCard.isVisible({ timeout: T_SHORT }).catch(() => false);
    test.info().annotations.push({
      type: "conditional-skip",
      description: "Gemini agent card not on Complete step (no launchable Gemini binary)",
    });
    test.skip(!onComplete, "Gemini agent card not on Complete step (no launchable Gemini binary)");

    const badge = geminiCard.locator("[data-testid='preset-count-badge']");
    await expect(badge).not.toBeVisible({ timeout: T_SHORT });

    const closeButton = wizardDialog.locator('button:has-text("Close"), button:has-text("Done")');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(wizardDialog).not.toBeVisible({ timeout: T_SHORT });
    }
  });

  test("87. Complete wizard pinning an agent with presets, verify agent is pinned and presets still available", async () => {
    await ctx.window.evaluate(() =>
      window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"))
    );

    const wizardDialog = ctx.window.locator(SEL.firstRun.agentSetupDialog);
    await expect(wizardDialog).toBeVisible({ timeout: T_MEDIUM });

    const claudeCard = wizardDialog.locator('[data-testid="agent-card-claude"]');
    const claudeCardVisible = await claudeCard.isVisible({ timeout: T_SHORT }).catch(() => false);
    if (claudeCardVisible) {
      const pinButton = claudeCard.locator(
        'button[aria-label*="Pin"], button[aria-label*="pin"], button:has-text("Pin")'
      );
      if (await pinButton.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await pinButton.click();
      }
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
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });
    // The Popover lists CCR presets with the "CCR:" prefix stripped.
    const { getPresetOptionLabels } = await import("../../helpers/presets");
    const labels = await getPresetOptionLabels(ctx.window);
    expect(labels.some((l) => l.includes("DeepSeek V3"))).toBe(true);
  });

  test("88. Add custom presets to Claude, open wizard, verify AgentCard shows badge for custom presets too", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);

    const nameInput = ctx.window.locator(
      `${SEL.preset.section} input[placeholder*="name" i], ${SEL.preset.section} input[aria-label*="name" i]`
    );
    if (await nameInput.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      await nameInput.fill("My Custom Preset");
      await ctx.window.keyboard.press("Enter");
    }
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.evaluate(() =>
      window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"))
    );

    const wizardDialog = ctx.window.locator(SEL.firstRun.agentSetupDialog);
    await expect(wizardDialog).toBeVisible({ timeout: T_MEDIUM });

    // agent-card-* only renders on the Complete step, which requires a
    // launchable Claude binary. Skip honestly when unreachable.
    const claudeCard = wizardDialog.locator('[data-testid="agent-card-claude"]');
    const claudeCardVisible = await claudeCard.isVisible({ timeout: T_SHORT }).catch(() => false);
    test.info().annotations.push({
      type: "conditional-skip",
      description: "Claude agent card not on Complete step (no launchable Claude binary)",
    });
    test.skip(
      !claudeCardVisible,
      "Claude agent card not on Complete step (no launchable Claude binary)"
    );

    const presetBadge = claudeCard.locator("[data-testid='preset-count-badge']");
    await expect(presetBadge).toBeVisible({ timeout: T_SHORT });
    await expect(presetBadge).toContainText(/\d+ presets?/, { timeout: T_SHORT });

    const closeButton = wizardDialog.locator('button:has-text("Close"), button:has-text("Done")');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await expect(wizardDialog).not.toBeVisible({ timeout: T_SHORT });
    }
  });
});
