import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomPreset,
  removeCcrConfig,
  waitForCcrPresets,
  getPresetRowByName,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;
let fakeBinDir: string;

function writeFakeClaude(): void {
  const scriptPath =
    process.platform === "win32"
      ? path.join(fakeBinDir, "claude.js")
      : path.join(fakeBinDir, "claude");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude fake v9.9.9');",
      "  process.exit(0);",
      "}",
      "console.log('FAKE_CLAUDE_READY pid=' + process.pid);",
      "process.stdout.write('> ');",
      "process.stdin.resume();",
      "const keepAlive = setInterval(() => {}, 1000);",
      "function shutdown() { clearInterval(keepAlive); process.exit(0); }",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(scriptPath, 0o755);

  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0\\claude.js" %*', ""].join("\r\n")
    );
  }
}

function launchEnv(): Record<string, string> {
  return {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
    ANTHROPIC_API_KEY: "e2e-fake-key",
  };
}

test.describe.serial("Presets: Custom Edit (25–34)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-preset-edit-bin-"));
    writeFakeClaude();
    ctx = await launchApp({ env: launchEnv() });
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-edit" });
    fixtureCleanup = () => {
      cleanup();
      removePathSync(fakeBinDir);
    };
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Preset Edit Test");
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  const openFirstPresetEditor = async () => {
    for (let round = 0; round < 3; round += 1) {
      const section = ctx.window.locator(SEL.preset.section);
      await expect(section).toBeVisible({ timeout: T_MEDIUM });
      const input = section.locator("[data-testid='preset-edit-input']");
      if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
        return input;
      }

      const editButtons = section.locator(SEL.preset.editButton);
      if (
        !(await editButtons
          .first()
          .isVisible({ timeout: T_SHORT })
          .catch(() => false))
      ) {
        await addCustomPreset(ctx.window);
        await goToClaudeSettings();
        await ctx.window.waitForTimeout(T_SETTLE);
        continue;
      }

      const count = await editButtons.count();
      for (let i = 0; i < count; i++) {
        const editBtn = editButtons.nth(i);
        if (!(await editBtn.isVisible({ timeout: 500 }).catch(() => false))) {
          continue;
        }
        await editBtn.scrollIntoViewIfNeeded().catch(() => undefined);
        await editBtn.hover({ force: true }).catch(() => undefined);

        const attempts = [
          () => editBtn.click({ force: true, noWaitAfter: true }),
          () => editBtn.click({ noWaitAfter: true }),
          () => editBtn.dispatchEvent("click"),
        ];
        for (const clickEdit of attempts) {
          await clickEdit().catch(() => undefined);
          if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
            return input;
          }
        }
      }

      await goToClaudeSettings();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    throw new Error("No custom preset edit input opened");
  };

  test("25. Pencil icon shows inline edit input", async () => {
    await goToClaudeSettings();
    const input = await openFirstPresetEditor();
    await expect(input).toBeVisible({ timeout: T_SHORT });
  });

  test("26. Renaming updates name in preset list", async () => {
    await goToClaudeSettings();
    const input = await openFirstPresetEditor();
    await expect(input).toBeVisible({ timeout: T_SHORT });
    await input.fill("Renamed Preset");
    await input.press("Enter");
    await ctx.window.waitForTimeout(T_SETTLE);
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: "Renamed Preset" }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("27. Renamed preset visible in agent tray sub-menu", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const trayButton = ctx.window.locator(SEL.agent.trayButton);
    await expect(trayButton).toBeVisible({ timeout: T_MEDIUM });
    await trayButton.click({ force: true, noWaitAfter: true });

    // Flat preset rows (#11691): narrow to Claude, then Right Arrow expands its
    // presets as sibling options rather than opening a submenu.
    const search = ctx.window.getByRole("combobox", {
      name: "Search agents, panels, and recipes",
    });
    await expect(search).toBeVisible({ timeout: T_MEDIUM });
    await search.fill("Claude");
    const parent = ctx.window.locator(SEL.preset.trayLaunchPresetParent).first();
    await expect(parent).toBeVisible({ timeout: T_MEDIUM });
    await search.press("ArrowRight");

    await expect(
      ctx.window.locator(SEL.preset.trayLaunchPresetItem, { hasText: "Renamed Preset" })
    ).toBeVisible({ timeout: T_MEDIUM });

    await ctx.window.keyboard.press("Escape");
    await ctx.window.keyboard.press("Escape");
  });

  test("28. Canceling rename leaves name unchanged", async () => {
    await goToClaudeSettings();
    const section = ctx.window.locator(SEL.preset.section);
    const input = await openFirstPresetEditor();
    await expect(input).toBeVisible({ timeout: T_SHORT });
    await input.fill("Should Not Save");
    await input.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });
    await expect(section.locator("span", { hasText: "Should Not Save" })).toHaveCount(0);
  });

  test("29. Empty rename rejected", async () => {
    await goToClaudeSettings();
    const input = await openFirstPresetEditor();
    await expect(input).toBeVisible({ timeout: T_SHORT });
    const priorName = await input.inputValue();
    expect(priorName.trim().length).toBeGreaterThan(0);
    await input.fill("");
    await input.press("Enter");
    // Empty submit must be rejected: the preset keeps its prior non-empty name
    // (no blank-named row replaces it).
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: priorName }).first()
    ).toBeVisible({ timeout: T_MEDIUM });
  });

  test("30. Very long name (200+ chars) works without crash", async () => {
    await goToClaudeSettings();
    const input = await openFirstPresetEditor();
    await expect(input).toBeVisible({ timeout: T_SHORT });
    const longName = "A".repeat(250);
    await input.fill(longName);
    await input.press("Enter");
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section.locator(SEL.preset.customBadge).first()).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).toHaveCount(0);
  });

  test("31. Edit button not shown for CCR presets", async () => {
    const { writeCcrConfig } = await import("../../helpers/presets");
    writeCcrConfig([{ id: "ccr-noedit", name: "No Edit", model: "noedit-model" }]);
    await waitForCcrPresets(ctx.window, ["No Edit"]);
    await goToClaudeSettings();
    const detail = await getPresetRowByName(ctx.window, "No Edit");
    await expect(detail).toBeVisible({ timeout: T_MEDIUM });
    await expect(detail.locator(SEL.preset.editButton)).toHaveCount(0);
  });

  test("32. Name with dangerous characters is rejected", async () => {
    await goToClaudeSettings();
    const input = await openFirstPresetEditor();
    await expect(input).toBeVisible({ timeout: T_SHORT });
    const priorName = await input.inputValue();
    expect(priorName.trim().length).toBeGreaterThan(0);
    // The `&` is in the dangerous-character set, so the rename is rejected and
    // the preset keeps its prior name.
    await input.fill("Test & Special");
    await input.press("Enter");
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section.locator("span", { hasText: "Test & Special" })).toHaveCount(0, {
      timeout: T_MEDIUM,
    });
    await expect(section.locator("span", { hasText: priorName }).first()).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("33. Name with emoji works", async () => {
    await goToClaudeSettings();
    const input = await openFirstPresetEditor();
    await expect(input).toBeVisible({ timeout: T_SHORT });
    await input.fill("Rocket Preset");
    await input.press("Enter");
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: "Rocket Preset" }).first()
    ).toBeVisible({ timeout: T_MEDIUM });
  });

  test("34. Edit persists across Settings close/reopen", async () => {
    await goToClaudeSettings();
    const input = await openFirstPresetEditor();
    await expect(input).toBeVisible({ timeout: T_SHORT });
    await input.fill("Persistent Name");
    await input.press("Enter");
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await goToClaudeSettings();
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: "Persistent Name" }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
  });
});
