import { describe, it, expect, vi, afterEach } from "vitest";
import {
  registerPanelKind,
  unregisterPanelKind,
  type PanelKindConfig,
} from "@shared/config/panelKindRegistry";

// Only the renderer-definition lookup is stubbed — the real `@/registry` barrel
// eagerly imports the whole panel component tree. Everything else runs against
// the real shared registry so the predicate is exercised on real config.
let registeredDefinitions = new Set<string>();
vi.mock("../panelKindRegistry", () => ({
  getPanelKindDefinition: (kindId: string) =>
    registeredDefinitions.has(kindId) ? { kind: kindId } : undefined,
}));

import { getSpawnablePanelKinds } from "../spawnablePanelKinds";

const PLUGIN_ID = "test-spawnable-plugin";

function allBuiltInsDefined() {
  registeredDefinitions = new Set([
    "terminal",
    "browser",
    "dev-preview",
    "review",
    "file",
    "file-browser",
    "diff",
  ]);
}

afterEach(() => {
  unregisterPanelKind(PLUGIN_ID);
  registeredDefinitions = new Set();
});

describe("getSpawnablePanelKinds", () => {
  it("keeps only kinds that opt into the palette", () => {
    allBuiltInsDefined();
    const ids = getSpawnablePanelKinds().map((c) => c.id);

    // diff and terminal both opt out, for different reasons (needs a target /
    // has dedicated spawn actions).
    expect(ids).not.toContain("diff");
    expect(ids).not.toContain("terminal");
    // ...while a kind that opts in and has a renderer is kept.
    expect(ids).toContain("review");
  });

  it("drops a plugin kind that opts out of the palette despite having a renderer", () => {
    // Discriminating counterpart to the above: the exclusion has to come from
    // showInPalette, not from a missing renderer definition.
    registerPanelKind({
      id: PLUGIN_ID,
      name: "Hidden Panel",
      iconId: "package",
      color: "#fff",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "test-plugin",
      showInPalette: false,
    });
    registeredDefinitions = new Set([PLUGIN_ID]);

    expect(getSpawnablePanelKinds().map((c) => c.id)).not.toContain(PLUGIN_ID);
  });

  it("never yields the reserved agent kind", () => {
    // "agent" gets a renderer definition here so the only thing that can
    // exclude it is the explicit reserved-id guard.
    allBuiltInsDefined();
    registeredDefinitions.add("agent");
    expect(getSpawnablePanelKinds().map((c) => c.id)).not.toContain("agent");
  });

  it("drops a kind with no registered renderer definition", () => {
    registeredDefinitions = new Set(["browser"]);
    const ids = getSpawnablePanelKinds().map((c) => c.id);

    expect(ids).toContain("browser");
    // review opts into the palette but has no definition registered here.
    expect(ids).not.toContain("review");
  });

  it("does not filter on dockability — non-dockable kinds are still spawnable", () => {
    allBuiltInsDefined();
    const ids = getSpawnablePanelKinds().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["review", "file-browser", "dev-preview"]));
  });

  it("includes a plugin kind once it has both palette opt-in and a definition", () => {
    const config: PanelKindConfig = {
      id: PLUGIN_ID,
      name: "Test Panel",
      iconId: "package",
      color: "#fff",
      hasPty: false,
      canRestart: false,
      canConvert: false,
      extensionId: "test-plugin",
    };
    registerPanelKind(config);

    // Registered but no renderer definition yet → not offered.
    registeredDefinitions = new Set();
    expect(getSpawnablePanelKinds().map((c) => c.id)).not.toContain(PLUGIN_ID);

    // Definition arrives → offered, with no registry subscription needed.
    registeredDefinitions = new Set([PLUGIN_ID]);
    expect(getSpawnablePanelKinds().map((c) => c.id)).toContain(PLUGIN_ID);
  });
});
