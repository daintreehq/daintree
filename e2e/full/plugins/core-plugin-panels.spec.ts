import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin } from "../../helpers/plugins";

/**
 * Plugin `panels` contribution (#10473). The sample manifest declares one
 * non-PTY panel (`id: "hello-panel"`). `PluginService` namespaces the kind id
 * as `${pluginId}.${panelId}`, so the contributed kind surfaces as
 * `daintree.hello.hello-panel`. This proves a declared panel contribution
 * actually registers a spawnable panel kind against the main-process registry
 * — the runtime source of truth the panel palette reads from.
 */
test.describe.serial("Core: Plugin panels contribution", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-panels");
    ctx = launched;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("registers the contributed panel kind in the main-process registry", async () => {
    const kinds = await ctx.window.evaluate(() => window.electron.plugin.getPanelKinds());
    const helloPanel = kinds.find((kind) => kind.id === "daintree.hello.hello-panel");

    expect(helloPanel).toBeDefined();
    expect(helloPanel).toMatchObject({
      id: "daintree.hello.hello-panel",
      name: "Hello Panel",
      extensionId: "daintree.hello",
      hasPty: false,
      showInPalette: true,
    });
  });
});
