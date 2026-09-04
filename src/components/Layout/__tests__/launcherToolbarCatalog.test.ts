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

// The project a project-scoped recipe's pin id is qualified by. Fixture recipes
// below declare `projectId` when they are meant to be project-scoped and omit it
// when they are meant to be global.
const PROJECT_ID = "project-a";

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

function recipeItem(id: string, name = id, projectId?: string): DockLaunchItem {
  return {
    category: "recipe",
    key: `recipe:${id}`,
    name,
    // `projectId` is what `getRecipeScope` reads to decide global vs
    // project-scoped, which in turn decides whether the pin id is qualified.
    recipe: { id, name, terminals: [], createdAt: 0, ...(projectId ? { projectId } : {}) },
    scopeLabel: projectId ? "Project-wide" : "Global",
    isShadowed: false,
  };
}

describe("resolveLauncherToolbarButtonId", () => {
  it("leaves a built-in agent on the id its own store already keys", () => {
    // A built-in's pin lives in `agentSettingsStore`. Minting a synthetic id for
    // it as well would split one button across two stores, and the two would
    // disagree the moment either was written.
    expect(resolveLauncherToolbarButtonId(agentItem(builtInAgentId), PROJECT_ID)).toBe(
      builtInAgentId
    );
  });

  it("leaves each of the four fixed panels on its own button id", () => {
    expect(resolveLauncherToolbarButtonId(panelItem("terminal"), PROJECT_ID)).toBe("terminal");
    expect(resolveLauncherToolbarButtonId(panelItem("browser"), PROJECT_ID)).toBe("browser");
    expect(resolveLauncherToolbarButtonId(panelItem("file-browser"), PROJECT_ID)).toBe(
      "file-browser"
    );
    // The one pair whose kind and button names differ. Resolving `dev-preview`
    // to a synthetic id would give the dev preview button a second key.
    expect(resolveLauncherToolbarButtonId(panelItem("dev-preview"), PROJECT_ID)).toBe("dev-server");
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
      const id = resolveLauncherToolbarButtonId(item, PROJECT_ID);
      expect(id, `${item.category} ${item.name} must be pinnable`).not.toBeNull();
      expect(isLauncherItemToolbarButtonId(id!)).toBe(true);
    }
  });

  it("qualifies a project-scoped recipe's id, and leaves a global one bare", () => {
    // A legacy in-repo recipe's id is derived from its filename, and
    // `.daintree/recipes/` is tracked in git — so two projects each holding a
    // `dev.json` produce the same `inrepo-dev`. Without the project in the key
    // one project's pin resolves to the other project's recipe.
    expect(
      resolveLauncherToolbarButtonId(recipeItem("inrepo-dev", "Dev", PROJECT_ID), PROJECT_ID)
    ).toBe(launcherItemToolbarButtonId("recipe", `${PROJECT_ID}:inrepo-dev`));
    // A global recipe is reachable from every project; qualifying it would
    // strand the pin on the next project switch.
    expect(resolveLauncherToolbarButtonId(recipeItem("g-1", "Global"), PROJECT_ID)).toBe(
      launcherItemToolbarButtonId("recipe", "g-1")
    );
  });

  it("keeps two projects' same-named legacy recipes on different ids", () => {
    const inA = resolveLauncherToolbarButtonId(
      recipeItem("inrepo-dev", "Dev", "project-a"),
      "project-a"
    );
    const inB = resolveLauncherToolbarButtonId(
      recipeItem("inrepo-dev", "Dev", "project-b"),
      "project-b"
    );
    expect(inA).not.toBe(inB);
  });

  it("tags each id with the category its row came from", () => {
    expect(
      decodeLauncherItemToolbarButtonId(resolveLauncherToolbarButtonId(agentItem("x"), PROJECT_ID)!)
    ).toEqual({ category: "agent", sourceId: "x" });
    expect(
      decodeLauncherItemToolbarButtonId(
        resolveLauncherToolbarButtonId(panelItem("review"), PROJECT_ID)!
      )
    ).toEqual({ category: "panel", sourceId: "review" });
    expect(
      decodeLauncherItemToolbarButtonId(
        resolveLauncherToolbarButtonId(recipeItem("r1"), PROJECT_ID)!
      )
    ).toEqual({ category: "recipe", sourceId: "r1" });
  });
});

describe("buildLauncherToolbarCatalog", () => {
  it("holds only the rows that need a synthetic id", () => {
    const catalog = buildLauncherToolbarCatalog(
      [
        agentItem(builtInAgentId),
        panelItem("terminal"),
        panelItem("dev-preview"),
        agentItem("acme.helper"),
        panelItem("review"),
        recipeItem("r1"),
      ],
      PROJECT_ID
    );
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
    const catalog = buildLauncherToolbarCatalog(
      [panelItem("review"), recipeItem("review")],
      PROJECT_ID
    );
    expect(catalog.size).toBe(2);
  });

  it("tells two same-named recipes in different scopes apart", () => {
    // Both are pinnable and both are called Deploy. The toolbar shows only a
    // glyph, so if the description did not carry the scope the two buttons,
    // their tooltips and their Settings switches would all read identically.
    const catalog = buildLauncherToolbarCatalog(
      [recipeItem("g-1", "Deploy"), recipeItem("p-1", "Deploy", PROJECT_ID)],
      PROJECT_ID
    );
    expect(catalog.size).toBe(2);

    const descriptions = Object.values(buildLauncherToolbarMeta(catalog)).map((m) => m.description);
    expect(new Set(descriptions).size).toBe(2);
  });

  it("does not resolve inherited Object properties as catalog members", () => {
    // Keys come from arbitrary agent, kind and recipe ids. A `Map` is what keeps
    // `catalog.get("constructor")` from answering with a function.
    const catalog = buildLauncherToolbarCatalog([recipeItem("r1")], PROJECT_ID);
    expect(catalog.get("constructor" as never)).toBeUndefined();
    expect(catalog.get("toString" as never)).toBeUndefined();
    expect(catalog.get("__proto__" as never)).toBeUndefined();
  });

  it("keeps the first of two rows sharing an id rather than churning the entry", () => {
    const first = recipeItem("r1", "First");
    const catalog = buildLauncherToolbarCatalog([first, recipeItem("r1", "Second")], PROJECT_ID);
    expect(catalog.size).toBe(1);
    expect(catalog.get(launcherItemToolbarButtonId("recipe", "r1"))!.item).toBe(first);
  });

  it("returns the same empty map for input with nothing to pin", () => {
    // `Toolbar` spreads this into a `useMemo`d registry; a fresh empty map each
    // render would rebuild every toolbar button on every store tick.
    const a = buildLauncherToolbarCatalog([agentItem(builtInAgentId)], PROJECT_ID);
    const b = buildLauncherToolbarCatalog([], PROJECT_ID);
    expect(a.size).toBe(0);
    expect(a).toBe(b);
  });
});

describe("buildLauncherToolbarMeta", () => {
  it("names each button after its row and says what pressing it does", () => {
    // The toolbar shows a glyph and nothing else, so the description is the only
    // thing telling a recipe named Review from the Review panel.
    const catalog = buildLauncherToolbarCatalog(
      [
        agentItem("acme.helper", "Helper"),
        panelItem("review", "Review"),
        recipeItem("r1", "Review"),
      ],
      PROJECT_ID
    );
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
      // Carries the scope: a recipe and a panel can share a name, and so can
      // two recipes in different scopes.
      description: "Run Review (Global)",
    });
  });

  it("gives every catalog entry an icon, so no pinned row renders a blank slot", () => {
    const catalog = buildLauncherToolbarCatalog(
      [
        // No icon on the agent, an unknown glyph id on the panel: both fall
        // back rather than resolving to undefined.
        agentItem("acme.helper"),
        panelItem("acme.unknown-kind"),
        recipeItem("r1"),
      ],
      PROJECT_ID
    );
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
