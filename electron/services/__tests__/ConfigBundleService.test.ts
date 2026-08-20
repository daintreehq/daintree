import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigBundleSectionId } from "../../../shared/types/configBundle.js";

/**
 * The fake store is a real dot-path store, not a stub that echoes writes back.
 * ConfigBundleService's whole contract is "read back before reporting applied",
 * so a store that can't actually lose a write would make every assertion here
 * vacuous.
 */
const storeState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

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
    node[last] = value;
  }

  return {
    get: vi.fn((path: string, fallback?: unknown) => read(path) ?? fallback),
    set: vi.fn((path: string, value: unknown) => write(path, value)),
  };
});

const BUILT_IN_AGENT_ID = "claude";

const mockRegistry = vi.hoisted(() => ({
  reload: vi.fn(),
}));

/** Mirrors the real service's contract: refuses built-in ids, persists to the store. */
const mockUserAgentRegistryService = vi.hoisted(() => {
  return class {
    private read(): Record<string, unknown> {
      const raw = mockStore.get("userAgentRegistry");
      return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    }
    getAgent(id: string) {
      return this.read()[id];
    }
    addAgent(config: { id: string }) {
      if (config.id === BUILT_IN_AGENT_ID) {
        return {
          success: false,
          error: `Agent ID "${config.id}" is reserved for built-in agents.`,
        };
      }
      mockStore.set("userAgentRegistry", { ...this.read(), [config.id]: config });
      return { success: true };
    }
    updateAgent(id: string, config: unknown) {
      mockStore.set("userAgentRegistry", { ...this.read(), [id]: config });
      return { success: true };
    }
    reload = mockRegistry.reload;
  };
});

const mockProjectStore = vi.hoisted(() => ({
  recipes: [] as Array<Record<string, unknown>>,
  getGlobalRecipes: vi.fn(),
  addGlobalRecipe: vi.fn(),
  updateGlobalRecipe: vi.fn(),
  deleteGlobalRecipe: vi.fn(),
}));

/** Only these sounds exist on this machine — anything else must be reported skipped. */
const ALLOWED_SOUNDS = vi.hoisted(() => new Set(["chime.wav", "ping.wav"]));

vi.mock("../../store.js", () => ({ store: mockStore }));

vi.mock("../UserAgentRegistryService.js", () => ({
  UserAgentRegistryService: mockUserAgentRegistryService,
  loadSanitizedUserAgentRegistry: () => {
    const raw = mockStore.get("userAgentRegistry");
    return raw && typeof raw === "object" ? raw : {};
  },
}));

vi.mock("../keybindingOverridesStore.js", () => ({
  getValidatedOverrides: () => {
    const raw = mockStore.get("keybindingOverrides.overrides");
    return raw && typeof raw === "object" ? raw : {};
  },
}));

vi.mock("../getSoundService.js", () => ({
  getAllowedSoundFiles: async () => ALLOWED_SOUNDS,
}));

vi.mock("../ProjectStore.js", () => ({ projectStore: mockProjectStore }));

const { ConfigBundleService } = await import("../ConfigBundleService.js");

function agent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Agent ${id}`,
    command: id,
    color: "#112233",
    iconId: "bot",
    supportsContextInjection: true,
    ...overrides,
  };
}

function makeService(rebuildMenu = vi.fn().mockResolvedValue(undefined)) {
  return { service: new ConfigBundleService({ rebuildMenu }), rebuildMenu };
}

beforeEach(() => {
  storeState.current = {
    userAgentRegistry: {},
    agentSettings: { agents: {} },
    keybindingOverrides: { overrides: {} },
    appTheme: {},
    notificationSettings: { completedSoundFile: "chime.wav", quietHoursEnabled: false },
    worktreeConfig: { pathPattern: "../{project}-worktrees/{branch}" },
  };
  mockProjectStore.recipes = [];
  vi.clearAllMocks();
  mockProjectStore.getGlobalRecipes.mockImplementation(async () => [...mockProjectStore.recipes]);
  mockProjectStore.addGlobalRecipe.mockImplementation(async (recipe: Record<string, unknown>) => {
    mockProjectStore.recipes.push(recipe);
  });
  mockProjectStore.updateGlobalRecipe.mockImplementation(
    async (id: string, updates: Record<string, unknown>) => {
      const index = mockProjectStore.recipes.findIndex((r) => r.id === id);
      if (index >= 0) {
        mockProjectStore.recipes[index] = { ...mockProjectStore.recipes[index], ...updates };
      }
    }
  );
  mockProjectStore.deleteGlobalRecipe.mockImplementation(async (id: string) => {
    mockProjectStore.recipes = mockProjectStore.recipes.filter((r) => r.id !== id);
  });
});

function statusFor(
  report: {
    sections: Array<{
      section: ConfigBundleSectionId;
      leaves: Array<{ key: string; status: string; reason?: string }>;
    }>;
  },
  section: ConfigBundleSectionId,
  key: string
) {
  return report.sections.find((s) => s.section === section)?.leaves.find((l) => l.key === key);
}

describe("ConfigBundleService.apply", () => {
  it("re-importing the same bundle changes nothing the second time", async () => {
    const { service } = makeService();
    const bundle = {
      userAgentRegistry: { helper: agent("helper") },
      keybindingOverrides: { "app.settings": ["Cmd+,"] },
      worktreeConfig: { pathPattern: "../trees/{branch}" },
    };

    const first = await service.apply(bundle);
    const second = await service.apply(bundle);

    const appliedIn = (r: Awaited<ReturnType<typeof service.apply>>) =>
      r.sections.reduce((sum, s) => sum + s.applied, 0);
    const unchangedIn = (r: Awaited<ReturnType<typeof service.apply>>) =>
      r.sections.reduce((sum, s) => sum + s.unchanged, 0);

    expect(appliedIn(first)).toBeGreaterThan(0);
    expect(appliedIn(second)).toBe(0);
    expect(unchangedIn(second)).toBe(appliedIn(first));
  });

  it("reports a value its own validator dropped as skipped, never applied", async () => {
    const { service } = makeService();

    const report = await service.apply({
      notificationSettings: { completedSoundFile: "not-on-this-machine.wav" },
    });

    const leaf = statusFor(report, "notificationSettings", "completedSoundFile");
    expect(leaf?.status).toBe("skipped");
    expect(leaf?.reason).toMatch(/sound file/i);
    // And the pre-existing value survived rather than being cleared.
    expect(mockStore.get("notificationSettings.completedSoundFile")).toBe("chime.wav");
  });

  it("applies a sound file that does exist on this machine", async () => {
    const { service } = makeService();

    const report = await service.apply({
      notificationSettings: { completedSoundFile: "ping.wav" },
    });

    expect(statusFor(report, "notificationSettings", "completedSoundFile")?.status).toBe("applied");
    expect(mockStore.get("notificationSettings.completedSoundFile")).toBe("ping.wav");
  });

  it("skips an agent the registry refuses instead of counting it applied", async () => {
    const { service } = makeService();

    const report = await service.apply({
      userAgentRegistry: {
        [BUILT_IN_AGENT_ID]: agent(BUILT_IN_AGENT_ID),
        helper: agent("helper"),
      },
    });

    expect(statusFor(report, "userAgentRegistry", BUILT_IN_AGENT_ID)?.status).toBe("skipped");
    expect(statusFor(report, "userAgentRegistry", "helper")?.status).toBe("applied");
  });

  it("merges rather than replaces — entries only on this machine survive", async () => {
    mockStore.set("userAgentRegistry", { local: agent("local") });
    const { service } = makeService();

    await service.apply({ userAgentRegistry: { imported: agent("imported") } });

    expect(Object.keys(mockStore.get("userAgentRegistry") as object).sort()).toEqual([
      "imported",
      "local",
    ]);
  });

  it("lets the imported value win on an id collision", async () => {
    mockStore.set("userAgentRegistry", { shared: agent("shared", { name: "Local name" }) });
    const { service } = makeService();

    await service.apply({
      userAgentRegistry: { shared: agent("shared", { name: "Imported name" }) },
    });

    const registry = mockStore.get("userAgentRegistry") as Record<string, { name: string }>;
    expect(registry.shared.name).toBe("Imported name");
  });

  it("skips an invalid worktree pattern and leaves the current one in place", async () => {
    const { service } = makeService();

    const report = await service.apply({ worktreeConfig: { pathPattern: "   " } });

    expect(statusFor(report, "worktreeConfig", "pathPattern")?.status).toBe("skipped");
    expect(mockStore.get("worktreeConfig.pathPattern")).toBe("../{project}-worktrees/{branch}");
  });

  it("rolls earlier sections back when a later one throws", async () => {
    mockProjectStore.addGlobalRecipe.mockRejectedValue(new Error("recipes.json is read-only"));
    const { service } = makeService();

    const report = await service.apply({
      worktreeConfig: { pathPattern: "../trees/{branch}" },
      globalRecipes: [{ id: "r1", name: "Fleet", terminals: [] }],
    });

    expect(report.outcome).toBe("rolled-back");
    expect(report.rolledBack).toBe(true);
    // The section that had already succeeded is back at its pre-import value.
    expect(mockStore.get("worktreeConfig.pathPattern")).toBe("../{project}-worktrees/{branch}");
  });

  it("rebuilds the menu only when keybindings actually changed", async () => {
    const { service, rebuildMenu } = makeService();

    await service.apply({ worktreeConfig: { pathPattern: "../trees/{branch}" } });
    expect(rebuildMenu).not.toHaveBeenCalled();

    await service.apply({ keybindingOverrides: { "app.settings": ["Cmd+,"] } });
    expect(rebuildMenu).toHaveBeenCalled();
  });

  it("marks a section absent from the bundle as not present", async () => {
    const { service } = makeService();

    const report = await service.apply({ worktreeConfig: { pathPattern: "../trees/{branch}" } });

    expect(report.sections.find((s) => s.section === "appTheme")?.present).toBe(false);
    expect(report.sections.find((s) => s.section === "worktreeConfig")?.present).toBe(true);
  });

  it("merges global recipes by id so a repeat import adds no duplicate", async () => {
    const { service } = makeService();
    const bundle = {
      globalRecipes: [{ id: "r1", name: "Fleet", terminals: [], createdAt: 5 }],
    };

    await service.apply(bundle);
    await service.apply(bundle);

    expect(mockProjectStore.recipes).toHaveLength(1);
  });
});

describe("ConfigBundleService.preview", () => {
  it("separates additions from replacements and already-matching values", async () => {
    mockStore.set("userAgentRegistry", { shared: agent("shared", { name: "Local" }) });
    mockStore.set("keybindingOverrides.overrides", { "app.settings": ["Cmd+,"] });
    const { service } = makeService();

    const preview = await service.preview({
      userAgentRegistry: {
        shared: agent("shared", { name: "Imported" }),
        brandNew: agent("brandNew"),
      },
      keybindingOverrides: { "app.settings": ["Cmd+,"] },
    });

    const agents = preview.find((p) => p.section === "userAgentRegistry");
    expect(agents).toMatchObject({ add: 1, update: 1, unchanged: 0 });

    const keys = preview.find((p) => p.section === "keybindingOverrides");
    expect(keys).toMatchObject({ add: 0, update: 0, unchanged: 1 });
  });

  it("omits sections the bundle doesn't carry", async () => {
    const { service } = makeService();

    const preview = await service.preview({ worktreeConfig: { pathPattern: "../x/{branch}" } });

    expect(preview.map((p) => p.section)).toEqual(["worktreeConfig"]);
  });
});

describe("ConfigBundleService.collect", () => {
  it("returns a snapshot the importer can round-trip back", async () => {
    mockStore.set("userAgentRegistry", { helper: agent("helper") });
    mockStore.set("keybindingOverrides.overrides", { "app.settings": ["Cmd+,"] });
    const { service } = makeService();

    const collected = await service.collect();

    expect(collected.userAgentRegistry).toEqual({ helper: agent("helper") });
    expect(collected.keybindingOverrides).toEqual({ "app.settings": ["Cmd+,"] });
    expect(collected.worktreeConfig).toEqual({
      pathPattern: "../{project}-worktrees/{branch}",
    });
  });

  it("leaves out theme fields that are this machine's browsing history", async () => {
    mockStore.set("appTheme", {
      colorSchemeId: "movile",
      recentSchemeIds: ["movile", "bondi"],
    });
    const { service } = makeService();

    const collected = await service.collect();

    expect(collected.appTheme).toEqual({ colorSchemeId: "movile" });
  });
});
