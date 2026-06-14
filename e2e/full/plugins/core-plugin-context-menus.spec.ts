import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin } from "../../helpers/plugins";

/**
 * Plugin `contextMenus` contribution (#10473). The sample manifest declares one
 * context-menu item (label "Say hello", location `worktree`) bound to the
 * plugin's own `daintree.hello.greet` action. This asserts the declared item
 * reaches the main-process context-menu registry — the runtime source the
 * renderer's `PluginContextMenuSection` reads when building a worktree menu.
 */
test.describe.serial("Core: Plugin context menus contribution", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-context-menus");
    ctx = launched;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("registers the contributed context-menu item in the main-process registry", async () => {
    const items = await ctx.window.evaluate(() => window.electron.plugin.contextMenuItems());
    const helloItem = items.find((entry) => entry.item.label === "Say hello");

    expect(helloItem).toBeDefined();
    expect(helloItem).toMatchObject({
      pluginId: "daintree.hello",
      item: {
        actionId: "daintree.hello.greet",
        location: "worktree",
        label: "Say hello",
      },
    });
  });
});
