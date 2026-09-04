import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createActionRegistry } from "./helpers/wireSurface";
import { renderPluginActionsDoc } from "../../../../scripts/codegen/pluginActionsDoc";
import { DENY_PLUGIN_DISPATCH_ACTION_IDS } from "@shared/config/actionIds";

const DOC_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/plugins/actions.md"
);

/**
 * `docs/plugins/actions.md` is generated from the action manifest, and the gate
 * lives here rather than in `npm run check` for a runtime reason: the generator
 * has to load the renderer graph through a one-shot Vite server, which takes
 * minutes, while this suite has the registry built already. A generated doc
 * nobody checks rots exactly as fast as the hand-written list it replaced.
 */
describe("docs/plugins/actions.md", () => {
  it("matches what the current action manifest generates", async () => {
    const registry = await createActionRegistry();
    const expected = renderPluginActionsDoc(registry);
    const actual = readFileSync(DOC_PATH, "utf-8");

    if (actual !== expected) {
      throw new Error(
        "docs/plugins/actions.md is stale. Run `npm run codegen:plugin-actions` and commit the result."
      );
    }
    expect(actual).toBe(expected);
  });

  it("lists no action a plugin's dispatch would be refused", async () => {
    const registry = await createActionRegistry();
    const doc = renderPluginActionsDoc(registry);

    // The whole point of the page is that everything on it is callable. An id
    // on the deny list, or one classed `restricted`, is refused at the boundary
    // whatever the page says.
    for (const id of DENY_PLUGIN_DISPATCH_ACTION_IDS) {
      expect(doc).not.toContain(`\`${id}\``);
    }
    for (const [id, factory] of registry) {
      if (factory().danger === "restricted") expect(doc).not.toContain(`\`${id}\``);
    }
  });

  it("marks optional arguments and lists required ones first", async () => {
    const registry = await createActionRegistry();
    const doc = renderPluginActionsDoc(registry);

    // `skills.load` takes exactly one required argument; `skills.search` takes
    // only optional ones. Together they pin both halves of the convention.
    expect(doc).toContain("| `skills.load` | Load skill | safe | `id` |");
    expect(doc).toMatch(/\| `skills\.search` \|[^|]+\| safe \| `limit\?`, `query\?` \|/);
  });
});
