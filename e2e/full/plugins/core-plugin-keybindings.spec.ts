import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin } from "../../helpers/plugins";

/**
 * Plugin `keybindings` contribution (#10473). The sample manifest declares one
 * keybinding (`CmdOrCtrl+Shift+H`) bound to the plugin's own
 * `daintree.hello.greet` action. This asserts the declared binding reaches the
 * main-process keybinding registry — the runtime source the renderer's
 * `usePluginKeybindings` hook pulls from.
 *
 * The assertion is registry-only by design: firing the combo and observing the
 * effect is flaky in headless CI (scope matching needs a focused element, and
 * `CmdOrCtrl` resolves to `Control` on Linux vs `Meta` on macOS), so the
 * registry is the stable cross-platform proof the contribution point is wired.
 */
test.describe.serial("Core: Plugin keybindings contribution", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-keybindings");
    ctx = launched;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("registers the contributed keybinding in the main-process registry", async () => {
    const keybindings = await ctx.window.evaluate(() => window.electron.plugin.keybindings());
    const helloBinding = keybindings.find(
      (entry) => entry.item.actionId === "daintree.hello.greet"
    );

    expect(helloBinding).toBeDefined();
    expect(helloBinding).toMatchObject({
      pluginId: "daintree.hello",
      item: {
        actionId: "daintree.hello.greet",
        combo: "CmdOrCtrl+Shift+H",
        scope: "global",
      },
    });
  });
});
