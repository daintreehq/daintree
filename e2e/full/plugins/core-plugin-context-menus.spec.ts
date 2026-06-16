import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin, waitForRichPluginReady } from "../../helpers/plugins";

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
});
