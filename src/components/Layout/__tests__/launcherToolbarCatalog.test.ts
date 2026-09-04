import { describe, it, expect } from "vitest";
import {
  decodeLauncherItemToolbarButtonId,
  isLauncherItemToolbarButtonId,
  launcherItemToolbarButtonId,
} from "@shared/types/toolbar";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import {
  buildLauncherToolbarCatalog,
  buildLauncherToolbarMeta,
  resolveLauncherToolbarButtonId,
} from "../launcherToolbarCatalog";
import type { DockLaunchItem } from "../dockLaunchItems";

// The catalog is the render gate: `Toolbar` builds a `buttonRegistry` entry per
// member and drops any pinned id without one. What it holds is therefore the
// whole answer to "which pins can currently render", so these tests are about
// membership and identity rather than presentation.

const builtInAgentId = BUILT_IN_AGENT_IDS[0]!;

function agentItem(id: string, name = id): DockLaunchItem {
  return {
    category: "agent",
    key: `agent:${id}`,
    name,
    agent: { id, name },
    agentBand: "launch",
  };
}

function panelItem(kindId: string, name = kindId): DockLaunchItem {
  return {
    category: "panel",
    key: `panel:${kindId}`,
    name,
    kindId,
    iconId: "terminal",
    color: "#000000",
    location: "grid",
  };
}

function recipeItem(id: string, name = id): DockLaunchItem {
  return {
    category: "recipe",
    key: `recipe:${id}`,
    name,
    recipe: { id, name, terminals: [], createdAt: 0 },
    scopeLabel: "Project",
    isShadowed: false,
  };
}

describe("resolveLauncherToolbarButtonId", () => {
  it("leaves a built-in agent on the id its own store already keys", () => {
    // A built-in's pin lives in `agentSettingsStore`. Minting a synthetic id for
    // it as well would split one button across two stores, and the two would
    // disagree the moment either was written.
    expect(resolveLauncherToolbarButtonId(agentItem(builtInAgentId))).toBe(builtInAgentId);
  });

  it("leaves each of the four fixed panels on its own button id", () => {
    expect(resolveLauncherToolbarButtonId(panelItem("terminal"))).toBe("terminal");
    expect(resolveLauncherToolbarButtonId(panelItem("browser"))).toBe("browser");
    expect(resolveLauncherToolbarButtonId(panelItem("file-browser"))).toBe("file-browser");
    // The one pair whose kind and button names differ. Resolving `dev-preview`
    // to a synthetic id would give the dev preview button a second key.
    expect(resolveLauncherToolbarButtonId(panelItem("dev-preview"))).toBe("dev-server");
  });

  it("gives every previously unpinnable row an id", () => {
    // The three classes the issue names: a plugin or user-defined agent, a panel
    // kind outside the fixed four, and any recipe.
    for (const item of [
      agentItem("acme.helper"),
      agentItem("my-custom-agent"),
      panelItem("review", "Review"),
      panelItem("file", "File Viewer"),
      panelItem("acme.videos", "Videos"),
      recipeItem("0f8c1d2e-3a4b-5c6d-7e8f-901234567890"),
      recipeItem("acme.deploy"),
    ]) {
      const id = resolveLauncherToolbarButtonId(item);
      expect(id, `${item.category} ${item.name} must be pinnable`).not.toBeNull();
      expect(isLauncherItemToolbarButtonId(id!)).toBe(true);
    }
  });

  it("tags each id with the category its row came from", () => {
    expect(
      decodeLauncherItemToolbarButtonId(resolveLauncherToolbarButtonId(agentItem("x"))!)
    ).toEqual({ category: "agent", sourceId: "x" });
    expect(
      decodeLauncherItemToolbarButtonId(resolveLauncherToolbarButtonId(panelItem("review"))!)
    ).toEqual({ category: "panel", sourceId: "review" });
    expect(
      decodeLauncherItemToolbarButtonId(resolveLauncherToolbarButtonId(recipeItem("r1"))!)
    ).toEqual({ category: "recipe", sourceId: "r1" });
  });
});

describe("buildLauncherToolbarCatalog", () => {
  it("holds only the rows that need a synthetic id", () => {
    const catalog = buildLauncherToolbarCatalog([
      agentItem(builtInAgentId),
      panelItem("terminal"),
      panelItem("dev-preview"),
      agentItem("acme.helper"),
      panelItem("review"),
      recipeItem("r1"),
    ]);
    expect([...catalog.keys()].sort()).toEqual(
      [
        launcherItemToolbarButtonId("agent", "acme.helper"),
        launcherItemToolbarButtonId("panel", "review"),
        launcherItemToolbarButtonId("recipe", "r1"),
      ].sort()
    );
  });

  it("keeps a row whose id collides across categories distinct", () => {
    // A recipe called Review and the Review panel are two different buttons.
    const catalog = buildLauncherToolbarCatalog([panelItem("review"), recipeItem("review")]);
    expect(catalog.size).toBe(2);
  });

  it("does not resolve inherited Object properties as catalog members", () => {
    // Keys come from arbitrary agent, kind and recipe ids. A `Map` is what keeps
    // `catalog.get("constructor")` from answering with a function.
    const catalog = buildLauncherToolbarCatalog([recipeItem("r1")]);
    expect(catalog.get("constructor" as never)).toBeUndefined();
    expect(catalog.get("toString" as never)).toBeUndefined();
    expect(catalog.get("__proto__" as never)).toBeUndefined();
  });

  it("keeps the first of two rows sharing an id rather than churning the entry", () => {
    const first = recipeItem("r1", "First");
    const catalog = buildLauncherToolbarCatalog([first, recipeItem("r1", "Second")]);
    expect(catalog.size).toBe(1);
    expect(catalog.get(launcherItemToolbarButtonId("recipe", "r1"))!.item).toBe(first);
  });

  it("returns the same empty map for input with nothing to pin", () => {
    // `Toolbar` spreads this into a `useMemo`d registry; a fresh empty map each
    // render would rebuild every toolbar button on every store tick.
    const a = buildLauncherToolbarCatalog([agentItem(builtInAgentId)]);
    const b = buildLauncherToolbarCatalog([]);
    expect(a.size).toBe(0);
    expect(a).toBe(b);
  });
});

describe("buildLauncherToolbarMeta", () => {
  it("names each button after its row and says what pressing it does", () => {
    // The toolbar shows a glyph and nothing else, so the description is the only
    // thing telling a recipe named Review from the Review panel.
    const catalog = buildLauncherToolbarCatalog([
      agentItem("acme.helper", "Helper"),
      panelItem("review", "Review"),
      recipeItem("r1", "Review"),
    ]);
    const meta = buildLauncherToolbarMeta(catalog);

    expect(meta[launcherItemToolbarButtonId("agent", "acme.helper")]).toMatchObject({
      label: "Helper",
      description: "Start Helper",
    });
    expect(meta[launcherItemToolbarButtonId("panel", "review")]).toMatchObject({
      label: "Review",
      description: "Open Review",
    });
    expect(meta[launcherItemToolbarButtonId("recipe", "r1")]).toMatchObject({
      label: "Review",
      description: "Run Review",
    });
  });

  it("gives every catalog entry an icon, so no pinned row renders a blank slot", () => {
    const catalog = buildLauncherToolbarCatalog([
      // No icon on the agent, an unknown glyph id on the panel: both fall back
      // rather than resolving to undefined.
      agentItem("acme.helper"),
      panelItem("acme.unknown-kind"),
      recipeItem("r1"),
    ]);
    const meta = buildLauncherToolbarMeta(catalog);
    expect(Object.keys(meta)).toHaveLength(3);
    for (const [id, entry] of Object.entries(meta)) {
      // Renderable, not merely present: a lucide glyph is a `forwardRef` object
      // rather than a function, so both shapes are legal and `undefined` — which
      // renders a blank slot — is the only failure.
      expect(entry.icon, id).toBeTruthy();
      expect(["function", "object"], id).toContain(typeof entry.icon);
    }
  });
});
