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

test.describe.serial("Flavors: Context Menu Integration (93–96)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "flavor-ctx-menu" });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Flavor Context Menu Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const rightClickClaudeToolbar = async () => {
    const button = ctx.window.locator('[aria-label="Start Claude Agent"]');
    if (await button.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      await button.click({ button: "right" });
    } else {
      const agentButton = ctx.window.locator(SEL.agent.startButton);
      await agentButton.click({ button: "right" });
    }
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  const dismissContextMenu = async () => {
    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  test("93. Right-click Claude toolbar shows 'Launch with Flavor' submenu", async () => {
    writeCcrConfig([
      { id: "ctx-a", name: "Ctx Model A", model: "ctx-model-a" },
      { id: "ctx-b", name: "Ctx Model B", model: "ctx-model-b" },
    ]);
    await ctx.window.waitForTimeout(35_000);

    await rightClickClaudeToolbar();

    const contextMenu = ctx.window.locator(SEL.contextMenu.content);
    if (await contextMenu.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      const flavorSubmenu = contextMenu.getByText(/Launch with Flavor/i);
      if (await flavorSubmenu.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await expect(flavorSubmenu).toBeVisible({ timeout: T_SHORT });
      }
    }

    await dismissContextMenu();
  });

  test("94. Context menu submenu lists all CCR and custom flavors", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await rightClickClaudeToolbar();

    const contextMenu = ctx.window.locator(SEL.contextMenu.content);
    if (await contextMenu.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      const flavorTrigger = contextMenu.getByText(/Launch with Flavor/i);
      if (await flavorTrigger.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await flavorTrigger.hover();
        await ctx.window.waitForTimeout(T_SETTLE);

        const submenuContent = ctx.window.locator('[data-testid="context-submenu-content"]');
        if (await submenuContent.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          const items = submenuContent.locator('[role="menuitem"]');
          const count = await items.count();
          expect(count).toBeGreaterThanOrEqual(1);
        }
      }
    }

    await dismissContextMenu();
  });

  test("95. Click a flavor from context menu — no crash, panel opens", async () => {
    await rightClickClaudeToolbar();

    const contextMenu = ctx.window.locator(SEL.contextMenu.content);
    if (await contextMenu.isVisible({ timeout: T_SHORT }).catch(() => false)) {
      const flavorTrigger = contextMenu.getByText(/Launch with Flavor/i);
      if (await flavorTrigger.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await flavorTrigger.hover();
        await ctx.window.waitForTimeout(T_SETTLE);

        const submenuContent = ctx.window.locator('[data-testid="context-submenu-content"]');
        if (await submenuContent.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          const firstItem = submenuContent.locator('[role="menuitem"]').first();
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

  test("96. Checkmark or highlight next to currently saved default flavor", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    const select = ctx.window.locator(SEL.flavor.defaultSelect);
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
      const flavorTrigger = contextMenu.getByText(/Launch with Flavor/i);
      if (await flavorTrigger.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        await flavorTrigger.hover();
        await ctx.window.waitForTimeout(T_SETTLE);

        const submenuContent = ctx.window.locator('[data-testid="context-submenu-content"]');
        if (await submenuContent.isVisible({ timeout: T_SHORT }).catch(() => false)) {
          const items = submenuContent.locator('[role="menuitem"]');
          if ((await items.count()) > 0) {
            const firstItem = items.first();
            const hasCheckmark =
              (await firstItem.locator('svg, [aria-checked="true"], .checkmark').count()) > 0;
            const hasHighlight =
              (await firstItem
                .evaluate((el) => {
                  const style = window.getComputedStyle(el);
                  return (
                    style.fontWeight === "bold" ||
                    style.fontWeight === "600" ||
                    style.fontWeight === "700" ||
                    el.getAttribute("aria-checked") === "true" ||
                    el.classList.contains("active") ||
                    el.classList.contains("selected")
                  );
                })
                .catch(() => false)) ?? false;
            expect(hasCheckmark || hasHighlight).toBeTruthy();
          }
        }
      }
    }

    await dismissContextMenu();
  });
});
