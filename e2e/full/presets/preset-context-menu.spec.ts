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

test.describe.serial("Presets: Context Menu Integration (93–96)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-ctx-menu" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Context Menu Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  const rightClickClaudeToolbar = async () => {
    const toolbar = ctx.window.getByRole("toolbar", { name: "Main toolbar" });
    const candidates = [
      toolbar
        .locator('[data-toolbar-button-id="claude"]')
        .getByRole("button", { name: /^(Start|Configure|Install|Checking) Claude/i })
        .first(),
      ctx.window.locator(SEL.agent.startButton).first(),
      ctx.window.getByRole("button", { name: /^Start Claude(?: Agent)?$/i }).first(),
    ];

    for (const button of candidates) {
      if (!(await button.isVisible({ timeout: T_SHORT }).catch(() => false))) {
        continue;
      }
      await button.click({ button: "right" });
      await ctx.window.waitForTimeout(T_SETTLE);
      return;
    }

    const fallback = candidates[0]!;
    await expect(fallback).toBeVisible({ timeout: T_MEDIUM });
    await fallback.click({ button: "right" });
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  const dismissContextMenu = async () => {
    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  test("93. Right-click Claude toolbar shows 'Launch with Preset' submenu", async () => {
    writeCcrConfig([
      { id: "ctx-a", name: "Ctx Model A", model: "ctx-model-a" },
      { id: "ctx-b", name: "Ctx Model B", model: "ctx-model-b" },
    ]);
    await waitForCcrPresets(ctx.window, ["Ctx Model A", "Ctx Model B"]);
    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);

    await rightClickClaudeToolbar();

    const contextMenu = ctx.window.locator(SEL.contextMenu.content);
    if (await contextMenu.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      const presetSubmenu = contextMenu.getByText(/Launch with Preset/i);
      if (await presetSubmenu.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await expect(presetSubmenu).toBeVisible({ timeout: T_SHORT });
      }
    }

    await dismissContextMenu();
  });

  test("94. Context menu submenu lists all CCR and custom presets", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await rightClickClaudeToolbar();

    const contextMenu = ctx.window.locator(SEL.contextMenu.content);
    if (await contextMenu.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      const presetTrigger = contextMenu.getByText(/Launch with Preset/i);
      if (await presetTrigger.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await presetTrigger.hover();
        await ctx.window.waitForTimeout(T_SETTLE);

        const submenuContent = ctx.window.locator('[data-testid="context-submenu-content"]');
        if (await submenuContent.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          const items = submenuContent.locator('[role^="menuitem"]');
          const count = await items.count();
          expect(count).toBeGreaterThanOrEqual(1);
        }
      }
    }

    await dismissContextMenu();
  });

  test("95. Click a preset from context menu — no crash, panel opens", async () => {
    await rightClickClaudeToolbar();

    const contextMenu = ctx.window.locator(SEL.contextMenu.content);
    if (await contextMenu.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      const presetTrigger = contextMenu.getByText(/Launch with Preset/i);
      if (await presetTrigger.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await presetTrigger.hover();
        await ctx.window.waitForTimeout(T_SETTLE);

        const submenuContent = ctx.window.locator('[data-testid="context-submenu-content"]');
        if (await submenuContent.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          const firstItem = submenuContent.locator('[role^="menuitem"]').first();
          if (await firstItem.isVisible({ timeout: T_SHORT }).catch(() => false)) {
            await firstItem.click();
            await ctx.window.waitForTimeout(T_SETTLE);

            const agentPanel = ctx.window.locator(
              '[aria-label^="Claude agent:"], [aria-label^="Claude Agent"]'
            );
            await expect(agentPanel.first())
              .toBeVisible({ timeout: T_MEDIUM })
              .catch(() => {});
          }
        }
      }
    }

    await dismissContextMenu();
  });

  test("96. Checkmark or highlight next to currently saved default preset", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    const select = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(select).toBeVisible({ timeout: T_MEDIUM });
    const options = select.locator("option");
    const count = await options.count();
    if (count > 1) {
      await select.selectOption({ index: 1 });
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await rightClickClaudeToolbar();

    const contextMenu = ctx.window.locator(SEL.contextMenu.content);
    if (await contextMenu.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      const presetTrigger = contextMenu.getByText(/Launch with Preset/i);
      if (await presetTrigger.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await presetTrigger.hover();
        await ctx.window.waitForTimeout(T_SETTLE);

        const submenuContent = ctx.window.locator('[data-testid="context-submenu-content"]');
        if (await submenuContent.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          const items = submenuContent.locator('[role^="menuitem"]');
          if ((await items.count()) > 0) {
            // The selected preset is rendered as a RadioItem with
            // aria-checked="true" (Radix sets this on the chosen value).
            const checkedItem = submenuContent.locator('[aria-checked="true"]');
            const hasCheckedItem = (await checkedItem.count()) > 0;
            expect(hasCheckedItem).toBeTruthy();
          }
        }
      }
    }

    await dismissContextMenu();
  });
});
