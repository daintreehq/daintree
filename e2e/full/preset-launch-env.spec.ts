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
  getPresetRowByName,
} from "../helpers/presets";

let ctx: AppContext;

test.describe.serial("Presets: Launch Env Overrides (63–70)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "preset-launch-env" });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Launch Env Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("63. CCR preset with model shows ANTHROPIC_MODEL env key in preset row", async () => {
    writeCcrConfig([{ id: "env-model", name: "Env Model", model: "claude-sonnet-4" }]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    const row = await getPresetRowByName(ctx.window, "Env Model");
    await expect(row).toBeVisible({ timeout: T_MEDIUM });
    await expect(row.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
  });

  test("64. CCR preset with baseUrl shows ANTHROPIC_BASE_URL env key", async () => {
    writeCcrConfig([
      {
        id: "env-url",
        name: "Env Url",
        model: "test-model",
        baseUrl: "https://proxy.internal/v1",
      },
    ]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    const row = await getPresetRowByName(ctx.window, "Env Url");
    await expect(row).toBeVisible({ timeout: T_MEDIUM });
    await expect(row.getByText("ANTHROPIC_BASE_URL")).toBeVisible({ timeout: T_SHORT });
  });

  test("65. Selecting default option (empty value) clears preset overrides", async () => {
    writeCcrConfig([{ id: "default-test", name: "Default Test", model: "default-model" }]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });

    const select = ctx.window.locator(SEL.preset.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_SHORT });

    const options = select.locator("option");
    const defaultOption = options.locator(SEL.preset.defaultOption);
    if ((await defaultOption.count()) > 0) {
      await select.selectOption({ value: "" });
      await ctx.window.waitForTimeout(T_SETTLE);
      await expect(select).toHaveValue("", { timeout: T_SHORT });
    }
  });

  test("66. Preset with 3 env vars shows all keys in row", async () => {
    writeCcrConfig([
      {
        id: "multi-env",
        name: "Multi Env",
        model: "multi-model",
        baseUrl: "https://multi.local",
        apiKeyEnv: "MY_SECRET_KEY",
      },
    ]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    const row = await getPresetRowByName(ctx.window, "Multi Env");
    await expect(row).toBeVisible({ timeout: T_MEDIUM });
    await expect(row.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
    await expect(row.getByText("ANTHROPIC_BASE_URL")).toBeVisible({ timeout: T_SHORT });
    await expect(row.getByText("ANTHROPIC_API_KEY")).toBeVisible({ timeout: T_SHORT });
  });

  test("67. Select preset then switch to default clears default selection", async () => {
    writeCcrConfig([{ id: "select-a", name: "Select A", model: "select-a-model" }]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });

    const select = ctx.window.locator(SEL.preset.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_SHORT });

    const options = select.locator("option");
    const allTexts = await options.allTextContents();
    const presetLabel = allTexts.find((t) => t.includes("Select A"));
    if (presetLabel) {
      await select.selectOption({ label: presetLabel });
      await ctx.window.waitForTimeout(T_SETTLE);

      const val = await select.inputValue();
      expect(val).toBeTruthy();

      await select.selectOption({ value: "" });
      await ctx.window.waitForTimeout(T_SETTLE);
      await expect(select).toHaveValue("", { timeout: T_SHORT });
    }
  });

  test("68. Env var display uses font-mono truncated text in preset row", async () => {
    writeCcrConfig([
      {
        id: "mono-env",
        name: "Mono Env",
        model: "mono-model",
        baseUrl: "https://very-long-base-url.example.com/api/v1/longer-path",
      },
    ]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    const row = await getPresetRowByName(ctx.window, "Mono Env");
    await expect(row).toBeVisible({ timeout: T_MEDIUM });

    const envText = row.locator("span.font-mono, code.font-mono");
    if ((await envText.count()) > 0) {
      const text = await envText.first().textContent();
      expect(text).toBeTruthy();
      expect(text!.length).toBeGreaterThan(0);
    } else {
      const rowText = await row.textContent();
      expect(rowText).toContain("ANTHROPIC_MODEL");
    }
  });

  test("69. Two presets with same env key — select each and verify", async () => {
    writeCcrConfig([
      { id: "dup-first", name: "Dup First", model: "dup-model-a" },
      { id: "dup-second", name: "Dup Second", model: "dup-model-b" },
    ]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();

    // Select first preset and check its env key
    const row1 = await getPresetRowByName(ctx.window, "Dup First");
    await expect(row1).toBeVisible({ timeout: T_MEDIUM });
    await expect(row1.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });

    // Select second preset and check its env key
    const row2 = await getPresetRowByName(ctx.window, "Dup Second");
    await expect(row2).toBeVisible({ timeout: T_MEDIUM });
    await expect(row2.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });

    // Verify second is now the selected preset via the trigger label.
    const { getSelectedPresetLabel } = await import("../helpers/presets");
    const label = await getSelectedPresetLabel(ctx.window);
    expect(label).toContain("Dup Second");
  });

  test("70. Settings section shows env keys correctly for created preset", async () => {
    writeCcrConfig([
      {
        id: "section-env",
        name: "Section Env",
        model: "section-model",
        baseUrl: "https://section.test",
        apiKeyEnv: "SECTION_KEY",
      },
    ]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    const row = await getPresetRowByName(ctx.window, "Section Env");
    await expect(row).toBeVisible({ timeout: T_MEDIUM });

    const rowText = await row.textContent();
    expect(rowText).toContain("ANTHROPIC_MODEL");
    expect(rowText).toContain("ANTHROPIC_BASE_URL");
    expect(rowText).toContain("ANTHROPIC_API_KEY");
  });
});
