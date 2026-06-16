import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin, waitForRichPluginReady } from "../../helpers/plugins";

/**
 * Plugin `agents` contribution (#10473). The `rich-daintree` sample declares one
 * agent (`id: "rich-sample"`) and the matching `agent:register` capability the
 * manifest gate requires. Plugin agent ids are additive and not namespaced, so
 * the contributed agent surfaces under its bare id in the effective registry.
 * This proves the declared agent reaches the main-process agent registry — the
 * runtime source the agent picker reads from.
 *
 * `getAgents()` returns a `Record<string, AgentConfig>` keyed by agent id, so
 * the assertion indexes by key rather than scanning an array. The agent rides on
 * `rich-daintree` (which already carries confirm-danger capabilities) rather
 * than the capability-free `hello-daintree`, so the reference plugin's
 * empty-permissions and safe-dispatch assertions stay intact.
 */
test.describe.serial("Core: Plugin agents contribution", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-agents");
    ctx = launched;
    fixtureCleanup = cleanup;
    await waitForRichPluginReady(ctx.app, ctx.window);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("registers the contributed agent in the main-process registry", async () => {
    const agents = await ctx.window.evaluate(() => window.electron.plugin.getAgents());

    expect(agents["rich-sample"]).toBeDefined();
    expect(agents["rich-sample"]).toMatchObject({
      id: "rich-sample",
      name: "Rich Sample",
      command: "echo",
      color: "#6366f1",
      iconId: "bot",
    });
  });
});
