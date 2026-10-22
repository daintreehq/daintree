import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ProjectModelResultSchema } from "../protocol.js";
import { inspectProject } from "../../../../../electron/services/elementPicker/projectAdapters/sveltekit/index.js";
import {
  createFixtureReader,
  createMemoryReader,
  fixtureWorktree,
} from "../../../../../electron/services/elementPicker/projectAdapters/sveltekit/__testing__/fixtureReader.js";

const reader = createFixtureReader();

/**
 * The project model now lives with the picker host; this plugin still sends it
 * over its own frozen wire schema until the plugin is retired, so every shape
 * the model can take must still parse there.
 */
describe("the host's project model on the plugin's wire", () => {
  it.each([
    ["plain", (root: string) => root],
    ["legacy", (root: string) => root],
    ["custom-routes", (root: string) => root],
    ["grouped", (root: string) => root],
    ["missing-install", (root: string) => root],
    ["monorepo", (root: string) => join(root, "apps", "site")],
  ])("accepts the %s fixture", async (fixture, appRootOf) => {
    const worktree = fixtureWorktree(fixture);
    const { model } = await inspectProject(reader, {
      worktreeRoot: worktree,
      appRoot: appRootOf(worktree),
    });

    expect(ProjectModelResultSchema.safeParse(model).success).toBe(true);
  });

  it("accepts a model whose routes directory could not be read", async () => {
    const memory = createMemoryReader({
      "/repo/package.json": JSON.stringify({ name: "indirect", devDependencies: {} }),
      "/repo/svelte.config.js": "import config from './config.js';\nexport default config;",
      "/repo/src/routes/+page.svelte": "<h1>Home</h1>",
    });
    const { model } = await inspectProject(memory, { worktreeRoot: "/repo", appRoot: "/repo" });

    expect(model.routesDirectory?.source).toBe("unresolved");
    expect(ProjectModelResultSchema.safeParse(model).success).toBe(true);
  });
});
