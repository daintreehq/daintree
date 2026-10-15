import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalRecipe } from "../../../shared/types/index.js";

/**
 * Undoing a settings copy (#13347): only leaves still holding what the copy
 * wrote go back, anything changed since stays and is reported, and nothing the
 * copy didn't touch is written. Same real dot-path fake store as the other
 * ConfigBundleService suites, so every claim is about what ends up stored.
 */
const storeState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const recipeState = vi.hoisted(() => ({ current: [] as TerminalRecipe[] }));

const mockStore = vi.hoisted(() => {
  function read(path: string): unknown {
    return path.split(".").reduce<unknown>((node, part) => {
      if (node === null || typeof node !== "object") return undefined;
      return (node as Record<string, unknown>)[part];
    }, storeState.current);
  }
  function write(path: string, value: unknown): void {
    const parts = path.split(".");
    const last = parts.pop() as string;
    let node = storeState.current;
    for (const part of parts) {
      if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[last] = structuredClone(value);
  }
  return {
    get: vi.fn((path: string, fallback?: unknown) => structuredClone(read(path)) ?? fallback),
    set: vi.fn((path: string, value: unknown) => write(path, value)),
  };
});

const mockProjectStore = vi.hoisted(() => ({
  getGlobalRecipes: vi.fn(async () => structuredClone(recipeState.current)),
  addGlobalRecipe: vi.fn(async (recipe: TerminalRecipe) => {
    recipeState.current.push(structuredClone(recipe));
  }),
  updateGlobalRecipe: vi.fn(async (id: string, updates: Partial<TerminalRecipe>) => {
    recipeState.current = recipeState.current.map((r) => (r.id === id ? { ...r, ...updates } : r));
  }),
  deleteGlobalRecipe: vi.fn(async (id: string) => {
    recipeState.current = recipeState.current.filter((r) => r.id !== id);
  }),
  transformGlobalRecipes: vi.fn(
    async (transform: (recipes: TerminalRecipe[]) => TerminalRecipe[] | null) => {
      const next = transform(structuredClone(recipeState.current));
      if (next !== null) recipeState.current = structuredClone(next);
    }
  ),
}));

vi.mock("../../store.js", () => ({ store: mockStore }));
vi.mock("../UserAgentRegistryService.js", () => ({
  UserAgentRegistryService: class {
    getAgent() {
      return undefined;
    }
    reload() {}
  },
  loadSanitizedUserAgentRegistry: () => mockStore.get("userAgentRegistry") ?? {},
}));
// Like the real one, it drops overrides for actions not registered right now.
vi.mock("../keybindingOverridesStore.js", () => ({
  getValidatedOverrides: () =>
    Object.fromEntries(
      Object.entries(
        (mockStore.get("keybindingOverrides.overrides") ?? {}) as Record<string, unknown>
      ).filter(([actionId]) => !actionId.startsWith("plugin."))
    ),
}));
vi.mock("../getSoundService.js", () => ({ getAllowedSoundFiles: async () => new Set<string>() }));
vi.mock("../ProjectStore.js", () => ({ projectStore: mockProjectStore }));
vi.mock("../../schemas/customSchemes.js", async () => {
  const { z } = await import("zod");
  return {
    appCustomSchemesWriteSchema: z.array(
      z.object({ id: z.string().min(1), name: z.string().min(1) }).passthrough()
    ),
  };
});

const { ConfigBundleService } = await import("../ConfigBundleService.js");
type Captured = import("../ConfigBundleService.js").CapturedSection;

function makeService() {
  return new ConfigBundleService({
    rebuildMenu: vi.fn().mockResolvedValue(undefined),
    refreshTitleBar: vi.fn().mockResolvedValue(undefined),
    availability: () => null,
  });
}

async function copy(incoming: Parameters<InstanceType<typeof ConfigBundleService>["apply"]>[0]) {
  const service = makeService();
  const captured: Captured[] = [];
  const report = await service.apply(incoming, { capture: captured });
  expect(report.outcome).toBe("applied");
  return { service, captured };
}

function statuses(results: Awaited<ReturnType<InstanceType<typeof ConfigBundleService>["undo"]>>) {
  return Object.fromEntries(
    results.flatMap(({ section, leaves }) =>
      leaves.map(({ key, status }) => [`${section}:${key}`, status])
    )
  );
}

function recipe(id: string, overrides: Partial<TerminalRecipe> = {}): TerminalRecipe {
  return {
    id,
    name: `Recipe ${id}`,
    terminals: [{ type: "terminal", title: id }],
    createdAt: 1,
    ...overrides,
  } as TerminalRecipe;
}

beforeEach(() => {
  vi.clearAllMocks();
  recipeState.current = [];
  storeState.current = {
    agentSettings: {
      globalSkipPermissions: false,
      agents: {
        claude: { customFlags: "--host", dangerousMode: "off", globalEnv: { TOKEN: "secret" } },
      },
    },
    helpAssistant: { bypassPermissions: false },
    globalEnvironmentVariables: { HOST_ONLY: "1", SHARED: "old" },
    keybindingOverrides: { overrides: {} },
    appTheme: { colorSchemeId: "daintree", recentSchemeIds: ["a"] },
  };
});

describe("capturing a copy", () => {
  it("keeps only leaves that actually changed, with absent and present told apart", async () => {
    const { captured } = await copy({
      globalEnvironment: { SHARED: "new", ADDED: "x", HOST_ONLY: "1" },
    });
    expect(captured).toEqual([
      {
        section: "globalEnvironment",
        leaves: [
          { key: "SHARED", before: "old", after: "new" },
          { key: "ADDED", after: "x" },
        ],
      },
    ]);
  });

  it("records nothing for a copy that changed nothing", async () => {
    const { captured } = await copy({ globalEnvironment: { SHARED: "old" } });
    expect(captured).toEqual([]);
  });
});

describe("undoing a copy", () => {
  it("restores what still holds the copy's value, removes what it added, and keeps edits since", async () => {
    const { service, captured } = await copy({
      globalEnvironment: { SHARED: "new", ADDED: "x", OTHER: "copied" },
    });
    // Edited on the host after the copy, and one added there since.
    mockStore.set("globalEnvironmentVariables.OTHER", "mine now");
    mockStore.set("globalEnvironmentVariables.LATER", "kept");

    const results = await service.undo(captured);

    expect(statuses(results)).toEqual({
      "globalEnvironment:SHARED": "restored",
      "globalEnvironment:ADDED": "restored",
      "globalEnvironment:OTHER": "edited",
    });
    expect(storeState.current.globalEnvironmentVariables).toEqual({
      HOST_ONLY: "1",
      SHARED: "old",
      OTHER: "mine now",
      LATER: "kept",
    });
  });

  it("keeps a stored entry the section's own read leaves out", async () => {
    const { service, captured } = await copy({ globalEnvironment: { SHARED: "new" } });
    // Not a string, so the section never reads it, but it is the host's.
    mockStore.set("globalEnvironmentVariables.ODD", 5);

    expect(statuses(await service.undo(captured))).toEqual({
      "globalEnvironment:SHARED": "restored",
    });
    expect(storeState.current.globalEnvironmentVariables).toEqual({
      HOST_ONLY: "1",
      SHARED: "old",
      ODD: 5,
    });
  });

  it("leaves a value already put back as it was alone", async () => {
    const { service, captured } = await copy({ globalEnvironment: { SHARED: "new" } });
    mockStore.set("globalEnvironmentVariables.SHARED", "old");
    const setCalls = mockStore.set.mock.calls.length;

    expect(statuses(await service.undo(captured))).toEqual({
      "globalEnvironment:SHARED": "unchanged",
    });
    expect(mockStore.set.mock.calls.length).toBe(setCalls);
  });

  it("unwinds bypass before agent settings, so a combined copy goes back whole", async () => {
    const original = structuredClone(storeState.current.agentSettings);
    const { service, captured } = await copy({
      agentSettings: { claude: { customFlags: "--copied" } },
      permissionBypass: {
        globalSkipPermissions: true,
        agents: { claude: { dangerousMode: "on" } },
      },
    });
    expect(captured.map((c) => c.section)).toEqual(["agentSettings", "permissionBypass"]);

    const results = await service.undo(captured);

    expect(Object.values(statuses(results)).every((s) => s === "restored")).toBe(true);
    expect(storeState.current.agentSettings).toEqual(original);
  });

  it("keeps an agent entry edited since the copy, whole", async () => {
    const { service, captured } = await copy({
      agentSettings: { claude: { customFlags: "--copied" } },
    });
    mockStore.set("agentSettings.agents.claude.customFlags", "--edited");

    expect(statuses(await service.undo(captured))).toEqual({ "agentSettings:claude": "edited" });
    expect(
      (storeState.current.agentSettings as { agents: { claude: unknown } }).agents.claude
    ).toMatchObject({ customFlags: "--edited" });
  });

  it("keeps shortcuts for actions this build hasn't registered right now", async () => {
    const { service, captured } = await copy({
      keybindingOverrides: { "terminal.new": ["Cmd+T"] },
    });
    // A plugin's shortcut, stored while its action isn't registered.
    mockStore.set("keybindingOverrides.overrides", {
      ...(mockStore.get("keybindingOverrides.overrides") as Record<string, unknown>),
      "plugin.thing": ["Cmd+K"],
    });

    expect(statuses(await service.undo(captured))).toEqual({
      "keybindingOverrides:terminal.new": "restored",
    });
    expect(mockStore.get("keybindingOverrides.overrides")).toEqual({
      "plugin.thing": ["Cmd+K"],
    });
  });

  it("takes recipes back in place without deleting and re-adding any", async () => {
    recipeState.current = [recipe("a"), recipe("b", { name: "Before" }), recipe("c")];
    const { service, captured } = await copy({
      globalRecipes: [recipe("b", { name: "Copied" }), recipe("new")],
    });
    // Added on the host after the copy.
    recipeState.current.push(recipe("later"));
    mockProjectStore.deleteGlobalRecipe.mockClear();
    mockProjectStore.addGlobalRecipe.mockClear();

    const results = await service.undo(captured);

    expect(statuses(results)).toEqual({
      "globalRecipes:b": "restored",
      "globalRecipes:new": "restored",
    });
    expect(recipeState.current.map((r) => [r.id, r.name])).toEqual([
      ["a", "Recipe a"],
      ["b", "Before"],
      ["c", "Recipe c"],
      ["later", "Recipe later"],
    ]);
    expect(mockProjectStore.deleteGlobalRecipe).not.toHaveBeenCalled();
    expect(mockProjectStore.addGlobalRecipe).not.toHaveBeenCalled();
  });

  it("keeps a recipe edited since the copy", async () => {
    recipeState.current = [recipe("b", { name: "Before" })];
    const { service, captured } = await copy({ globalRecipes: [recipe("b", { name: "Copied" })] });
    recipeState.current[0].name = "Renamed here";

    expect(statuses(await service.undo(captured))).toEqual({ "globalRecipes:b": "edited" });
    expect(recipeState.current[0].name).toBe("Renamed here");
  });

  it("takes a custom theme and a scheme choice back, leaving the rest of the theme", async () => {
    const { service, captured } = await copy({
      appTheme: { colorSchemeId: "mine", customSchemes: [{ id: "mine", name: "Mine" }] },
    });
    mockStore.set("appTheme.recentSchemeIds", ["a", "mine"]);

    const results = await service.undo(captured);

    expect(statuses(results)).toEqual({
      "appTheme:colorSchemeId": "restored",
      "appTheme:theme:mine": "restored",
    });
    expect(storeState.current.appTheme).toEqual({
      colorSchemeId: "daintree",
      recentSchemeIds: ["a", "mine"],
      customSchemes: [],
    });
  });
});
