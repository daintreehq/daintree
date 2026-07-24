import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin, waitForRichPluginReady } from "../../helpers/plugins";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_LONG } from "../../helpers/timeouts";

/**
 * Plugin `contextMenus` contribution (#10473). The `rich-daintree` sample
 * declares one context-menu item (label "Rich sample action", location
 * `worktree`) bound to the plugin's own `daintree.rich.ready` action. This
 * asserts the declared item reaches the main-process context-menu registry —
 * the runtime source the renderer's `PluginContextMenuSection` reads when
 * building a worktree menu.
 */
test.describe.serial("Core: Plugin context menus contribution", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-context-menus");
    ctx = launched;
    fixtureCleanup = cleanup;
    await waitForRichPluginReady(ctx.app, ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("registers the contributed context-menu item in the main-process registry", async () => {
    const items = await ctx.window.evaluate(() => window.electron.plugin.contextMenuItems());
    const richItem = items.find((entry) => entry.item.label === "Rich sample action");

    expect(richItem).toBeDefined();
    expect(richItem).toMatchObject({
      pluginId: "daintree.rich",
      item: {
        actionId: "daintree.rich.ready",
        location: "worktree",
        label: "Rich sample action",
      },
    });
  });

  // A worktree card exposes the same item list through two surfaces, so a
  // contributed item has to reach both. It reached only the right-click menu
  // until the section moved inside the shared item list.
  test("surfaces the contributed item in both worktree menus", async () => {
    const { window } = ctx;
    const card = window.locator(SEL.worktree.mainCard);
    await expect(card).toBeVisible({ timeout: T_LONG });

    const pluginItem = window.getByRole("menuitem", { name: "Rich sample action" });
    const closeMenu = async () => {
      await window.keyboard.press("Escape");
      await expect(window.locator('[role="menu"]')).toHaveCount(0, { timeout: T_SHORT });
    };

    await test.step("Actions dropdown lists the plugin item", async () => {
      await card.locator(SEL.worktree.actionsMenu).click();
      await expect(pluginItem).toBeVisible({ timeout: T_SHORT });
      await closeMenu();
    });

    await test.step("Right-click menu lists the plugin item", async () => {
      await card.click({ button: "right", position: { x: 40, y: 12 } });
      await expect(pluginItem).toBeVisible({ timeout: T_SHORT });
      await closeMenu();
    });
  });
});
