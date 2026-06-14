import { test, expect } from "@playwright/test";
import { closeApp, type AppContext } from "../../helpers/launch";
import { launchWithSamplePlugin } from "../../helpers/plugins";

/**
 * Plugin `agents` contribution (#10473). The sample manifest declares one agent
 * (`id: "hello-sample"`) and the matching `agent:register` capability the
 * manifest gate requires. Plugin agent ids are additive and not namespaced, so
 * the contributed agent surfaces under its bare id in the effective registry.
 * This proves the declared agent reaches the main-process agent registry — the
 * runtime source the agent picker reads from.
 *
 * `getAgents()` returns a `Record<string, AgentConfig>` keyed by agent id, so
 * the assertion indexes by key rather than scanning an array.
 */
test.describe.serial("Core: Plugin agents contribution", () => {
  let ctx: AppContext;
  let fixtureCleanup: (() => void) | undefined;

  test.beforeAll(async () => {
    const { ctx: launched, cleanup } = await launchWithSamplePlugin("plugin-agents");
    ctx = launched;
    fixtureCleanup = cleanup;
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("registers the contributed agent in the main-process registry", async () => {
    const agents = await ctx.window.evaluate(() => window.electron.plugin.getAgents());

    expect(agents["hello-sample"]).toBeDefined();
    expect(agents["hello-sample"]).toMatchObject({
      id: "hello-sample",
      name: "Hello Sample",
      command: "echo",
      color: "#6366f1",
      iconId: "bot",
    });
  });
});
