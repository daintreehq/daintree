import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliAvailability } from "../../../shared/types/ipc/system.js";

/**
 * The portable catalog behind Copy settings (#13346): field-level agent
 * settings, the opt-in bypass and environment sections, the service-backed
 * scalar sections, and the revision a host checks before applying.
 *
 * Same real dot-path fake store as ConfigBundleService.test.ts: every claim
 * here is about what lands in the store and what is left alone.
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
    node[last] = structuredClone(value);
  }
  return {
    get: vi.fn((path: string, fallback?: unknown) => structuredClone(read(path)) ?? fallback),
    set: vi.fn((path: string, value: unknown) => write(path, value)),
  };
});

const services = vi.hoisted(() => ({
  hibernation: { updateConfig: vi.fn() },
  idleNotify: { updateConfig: vi.fn() },
  idleClose: { updateConfig: vi.fn() },
  pluginChecks: { updateSettings: vi.fn() },
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
vi.mock("../keybindingOverridesStore.js", () => ({
  getValidatedOverrides: () => mockStore.get("keybindingOverrides.overrides") ?? {},
}));
vi.mock("../getSoundService.js", () => ({ getAllowedSoundFiles: async () => new Set<string>() }));
vi.mock("../ProjectStore.js", () => ({
  projectStore: { getGlobalRecipes: vi.fn(async () => []) },
}));
vi.mock("../HibernationService.js", () => ({
  getHibernationService: () => services.hibernation,
}));
vi.mock("../IdleTerminalNotificationService.js", () => ({
  getIdleTerminalNotificationService: () => services.idleNotify,
}));
vi.mock("../IdleBackgroundAutoCloseService.js", () => ({
  getIdleBackgroundAutoCloseService: () => services.idleClose,
}));
vi.mock("../PluginUpdateCheckService.js", () => ({
  getPluginUpdateCheckService: () => services.pluginChecks,
}));

const { ConfigBundleService } = await import("../ConfigBundleService.js");

function makeService(
  options: {
    availability?: CliAvailability | null;
    commandAvailable?: (command: string) => Promise<boolean>;
    platform?: NodeJS.Platform;
  } = {}
) {
  return new ConfigBundleService({
    rebuildMenu: vi.fn().mockResolvedValue(undefined),
    refreshTitleBar: vi.fn().mockResolvedValue(undefined),
    availability: () => options.availability ?? null,
    commandAvailable: options.commandAvailable,
    platform: options.platform,
  });
}

function agents(): Record<string, Record<string, unknown>> {
  return (storeState.current.agentSettings as { agents: Record<string, Record<string, unknown>> })
    .agents;
}

beforeEach(() => {
  vi.clearAllMocks();
  services.hibernation.updateConfig.mockImplementation((patch: Record<string, unknown>) =>
    mockStore.set("hibernation", { ...(mockStore.get("hibernation") as object), ...patch })
  );
  services.idleNotify.updateConfig.mockImplementation((patch: Record<string, unknown>) =>
    mockStore.set("idleTerminalNotify", {
      ...(mockStore.get("idleTerminalNotify") as object),
      ...patch,
    })
  );
  services.pluginChecks.updateSettings.mockImplementation((patch: { enabled: boolean }) =>
    mockStore.set("pluginBackgroundUpdateCheck", { enabled: patch.enabled, lastCheckedAt: 42 })
  );
  storeState.current = {
    agentSettings: {
      globalSkipPermissions: false,
      agents: {
        claude: {
          customFlags: "--host",
          dangerousMode: "off",
          worktreePresets: { "wt-1": "fast" },
          globalEnv: { ANTHROPIC_API_KEY: "host-secret", REGION: "eu" },
          customPresets: [
            { id: "fast", name: "Fast", env: { MODEL_TOKEN: "host-token" }, dangerousMode: "on" },
            { id: "host-only", name: "Host only" },
          ],
        },
      },
    },
    helpAssistant: { bypassPermissions: false, modelIds: { claude: "claude-sonnet-4-6" } },
    hibernation: { enabled: false, inactiveThresholdHours: 24 },
    idleTerminalNotify: { enabled: true, thresholdMinutes: 60 },
    pluginBackgroundUpdateCheck: { enabled: false, lastCheckedAt: 42 },
    agentUpdateSettings: { autoCheck: true, checkFrequencyHours: 24, lastAutoCheck: 1234 },
    globalEnvironmentVariables: { HOST_ONLY: "1", SHARED: "old" },
    keybindingOverrides: { overrides: {} },
  };
});

describe("agent settings travel by field", () => {
  it("exports only portable fields: no bypass, no worktree bookkeeping, nothing unnamed", async () => {
    agents().claude.someFutureField = "x";
    const { agentSettings } = await makeService().collect(["agentSettings"]);
    expect(agentSettings).toEqual({
      claude: {
        customFlags: "--host",
        globalEnv: { ANTHROPIC_API_KEY: "host-secret", REGION: "eu" },
        customPresets: [
          { id: "fast", name: "Fast", env: { MODEL_TOKEN: "host-token" } },
          { id: "host-only", name: "Host only" },
        ],
      },
    });
  });

  it("merges env per name and presets per id, leaving what the copy didn't carry", async () => {
    const report = await makeService().apply({
      agentSettings: {
        claude: {
          customFlags: "--copied",
          // The secret was withheld at the source: absent, not blank.
          globalEnv: { REGION: "us", NEW_VAR: "1" },
          customPresets: [
            { id: "fast", name: "Fast copied", env: { EXTRA: "y" } },
            { id: "new", name: "New preset" },
          ],
        },
      },
    });

    expect(report.outcome).toBe("applied");
    expect(agents().claude).toEqual({
      customFlags: "--copied",
      dangerousMode: "off",
      worktreePresets: { "wt-1": "fast" },
      globalEnv: { ANTHROPIC_API_KEY: "host-secret", REGION: "us", NEW_VAR: "1" },
      customPresets: [
        {
          id: "fast",
          name: "Fast copied",
          env: { MODEL_TOKEN: "host-token", EXTRA: "y" },
          dangerousMode: "on",
        },
        { id: "host-only", name: "Host only" },
        { id: "new", name: "New preset" },
      ],
    });
  });

  it("ignores bypass fields an old file carries inside agent settings", async () => {
    await makeService().apply({
      agentSettings: {
        claude: { customFlags: "--x", dangerousMode: "on", dangerousArgs: "--yolo" },
      },
    });
    expect(agents().claude.dangerousMode).toBe("off");
    expect(agents().claude.dangerousArgs).toBeUndefined();
  });

  it("skips a default preset the host doesn't define, in the preview and the apply", async () => {
    const service = makeService();
    const incoming = { agentSettings: { claude: { presetId: "missing", customFlags: "--y" } } };
    const [preview] = await service.preview(incoming);
    expect(preview.skipped).toEqual([
      {
        key: "claude.presetId",
        label: "Claude default preset",
        reason: "That preset isn't defined",
      },
    ]);

    const report = await service.apply(incoming);
    const leaves = report.sections.find((s) => s.section === "agentSettings")?.leaves ?? [];
    expect(leaves).toContainEqual({
      key: "claude.presetId",
      status: "skipped",
      reason: "That preset isn't defined",
    });
    expect(agents().claude.presetId).toBeUndefined();
    expect(agents().claude.customFlags).toBe("--y");
  });

  it("reads a re-copy of what the host already has as unchanged", async () => {
    const service = makeService();
    const exported = await service.collect(["agentSettings"]);
    const [preview] = await service.preview(exported);
    expect(preview).toMatchObject({ add: 0, update: 0, unchanged: 1 });
  });
});

describe("permission bypass", () => {
  it("exports the global, agent, preset and assistant bypass on its own", async () => {
    const { permissionBypass } = await makeService().collect(["permissionBypass"]);
    expect(permissionBypass).toEqual({
      globalSkipPermissions: false,
      assistant: false,
      agents: { claude: { dangerousMode: "off", presets: { fast: { dangerousMode: "on" } } } },
    });
  });

  it("applies onto existing presets and skips a preset the host doesn't have", async () => {
    const report = await makeService().apply({
      permissionBypass: {
        globalSkipPermissions: true,
        agents: {
          claude: {
            dangerousMode: "on",
            presets: { "host-only": { dangerousMode: "off" }, nowhere: { dangerousMode: "on" } },
          },
        },
      },
    });
    const section = report.sections.find((s) => s.section === "permissionBypass");
    expect(section?.leaves).toEqual(
      expect.arrayContaining([
        { key: "globalSkipPermissions", status: "applied" },
        { key: "agents.claude", status: "applied" },
        {
          key: "agents.claude.presets.nowhere",
          status: "skipped",
          reason: "That preset isn't defined",
        },
      ])
    );
    expect(
      (storeState.current.agentSettings as Record<string, unknown>).globalSkipPermissions
    ).toBe(true);
    expect(agents().claude.dangerousMode).toBe("on");
    expect(agents().claude.dangerousEnabled).toBe(true);
    expect(agents().claude.customPresets).toEqual([
      { id: "fast", name: "Fast", env: { MODEL_TOKEN: "host-token" }, dangerousMode: "on" },
      { id: "host-only", name: "Host only", dangerousMode: "off", dangerousEnabled: false },
    ]);
    // Agent preferences are untouched by a bypass-only copy.
    expect(agents().claude.customFlags).toBe("--host");
  });

  it("counts a preset arriving in the same copy's agent settings, and previews its override", async () => {
    agents().claude.dangerousEnabled = false;
    const [, bypass] = await makeService().preview({
      agentSettings: { claude: { customPresets: [{ id: "arriving", name: "Arriving" }] } },
      permissionBypass: {
        agents: {
          claude: {
            dangerousMode: "off",
            dangerousEnabled: false,
            presets: { arriving: { dangerousMode: "on" } },
          },
        },
      },
    });
    expect(bypass.section).toBe("permissionBypass");
    expect(bypass.skipped).toBeUndefined();
    // The agent's own mode is unchanged; the arriving preset's override is the change.
    expect(bypass.update).toBe(1);
  });

  it("reads a legacy enabled flag as the mode it means, so it can't sit under a host veto", async () => {
    await makeService().apply({
      permissionBypass: { agents: { claude: { dangerousEnabled: true } } },
    });
    expect(agents().claude.dangerousMode).toBe("on");
    expect(agents().claude.dangerousEnabled).toBe(true);
  });
});

describe("assistant models", () => {
  it("skips agents that can't run the assistant or aren't installed, and merges the rest", async () => {
    const service = makeService({
      availability: { claude: "ready", codex: "missing" } as CliAvailability,
    });
    const incoming = {
      assistantModels: { claude: "claude-opus-4-1", codex: "gpt-5", aider: "x" },
    };
    const [preview] = await service.preview(incoming);
    expect(preview.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "codex", reason: "Its CLI isn't installed" }),
        expect.objectContaining({ key: "aider", reason: "Can't run the assistant" }),
      ])
    );
    expect(preview.changes.map((c) => c.key)).toEqual(["claude"]);

    await service.apply(incoming);
    expect((storeState.current.helpAssistant as Record<string, unknown>).modelIds).toEqual({
      claude: "claude-opus-4-1",
    });
  });
});

describe("global environment", () => {
  it("merges per name and refuses anything that looks like a secret, on the receiving side too", async () => {
    const report = await makeService().apply({
      globalEnvironment: { SHARED: "new", ADDED: "1", DB_PASSWORD: "hunter2" },
    });
    expect(storeState.current.globalEnvironmentVariables).toEqual({
      HOST_ONLY: "1",
      SHARED: "new",
      ADDED: "1",
    });
    expect(report.sections.find((s) => s.section === "globalEnvironment")?.leaves).toContainEqual({
      key: "DB_PASSWORD",
      status: "skipped",
      reason: "Looks like a secret, so it stays on each machine",
    });
  });
});

describe("service-backed settings", () => {
  it("writes through the service setter, clamped the way the service clamps", async () => {
    const report = await makeService().apply({
      hibernation: { enabled: true, inactiveThresholdHours: 500 },
    });
    expect(services.hibernation.updateConfig).toHaveBeenCalledWith({
      enabled: true,
      inactiveThresholdHours: 168,
    });
    expect(report.sections.find((s) => s.section === "hibernation")?.applied).toBe(2);
  });

  it("skips a field this version doesn't have and a value it can't store", async () => {
    const service = makeService();
    const incoming = { idleTerminalNotify: { thresholdMinutes: "soon", someNewField: true } };
    const [preview] = await service.preview(incoming);
    expect(preview.skipped?.map((s) => s.key).sort()).toEqual(["someNewField", "thresholdMinutes"]);
    await service.apply(incoming);
    expect(services.idleNotify.updateConfig).not.toHaveBeenCalled();
  });

  it("keeps this machine's last-check timestamps", async () => {
    await makeService().apply({
      agentUpdateChecks: { autoCheck: false, checkFrequencyHours: 12 },
      pluginUpdateChecks: { enabled: true },
    });
    expect(storeState.current.agentUpdateSettings).toEqual({
      autoCheck: false,
      checkFrequencyHours: 12,
      lastAutoCheck: 1234,
    });
    expect(services.pluginChecks.updateSettings).toHaveBeenCalledWith({ enabled: true });
  });
});

describe("revision", () => {
  it("changes when anything the sections could change does, and only then", async () => {
    const service = makeService();
    const before = await service.revision(["agentSettings"]);
    // A field the copy never carries still counts: the apply writes the whole record.
    agents().claude.worktreePresets = { "wt-2": "fast" };
    const afterRelevant = await service.revision(["agentSettings"]);
    expect(afterRelevant).not.toBe(before);

    storeState.current.globalEnvironmentVariables = { CHANGED: "1" };
    expect(await service.revision(["agentSettings"])).toBe(afterRelevant);
  });
});

describe("withheld values leave the host's own in place", () => {
  it("keeps a custom agent's args when the copy withheld them", async () => {
    const base = {
      id: "mine",
      name: "Mine",
      command: "mine-cli",
      color: "#112233",
      iconId: "bot",
      supportsContextInjection: true,
    };
    storeState.current.userAgentRegistry = { mine: { ...base, args: ["--token", "host-secret"] } };
    const service = makeService();
    const incoming = { userAgentRegistry: { mine: { ...base, name: "Mine renamed" } } };
    const [preview] = await service.preview(incoming);
    expect(preview).toMatchObject({ update: 1, add: 0 });
    // The registry service is mocked here, so the merge is checked on what apply asks it to write.
    const { UserAgentRegistryService } = await import("../UserAgentRegistryService.js");
    const proto = UserAgentRegistryService.prototype as unknown as Record<string, unknown>;
    const original = { getAgent: proto.getAgent, updateAgent: proto.updateAgent };
    const update = vi.fn(() => ({ success: true }));
    proto.getAgent = () => (storeState.current.userAgentRegistry as Record<string, unknown>).mine;
    proto.updateAgent = update;
    try {
      await service.apply(incoming);
    } finally {
      Object.assign(proto, original);
    }
    expect(update).toHaveBeenCalledWith(
      "mine",
      expect.objectContaining({ name: "Mine renamed", args: ["--token", "host-secret"] })
    );
  });

  it("merges a recipe terminal's env per name, keeping a withheld secret", async () => {
    const { projectStore } = await import("../ProjectStore.js");
    const recipes = [
      {
        id: "r1",
        name: "Dev",
        terminals: [
          { type: "terminal", command: "npm run dev", env: { DB_PASSWORD: "host", PORT: "1" } },
        ],
      },
    ];
    const store = projectStore as unknown as Record<string, ReturnType<typeof vi.fn>>;
    store.getGlobalRecipes.mockImplementation(async () => structuredClone(recipes));
    store.updateGlobalRecipe = vi.fn(async (id: string, updates: Record<string, unknown>) => {
      const index = recipes.findIndex((r) => r.id === id);
      recipes[index] = { ...recipes[index], ...updates } as (typeof recipes)[number];
    });
    const service = makeService();
    const incoming = {
      globalRecipes: [
        {
          id: "r1",
          name: "Dev",
          terminals: [{ type: "terminal", command: "npm run dev", env: { PORT: "2" } }],
        },
      ],
    };
    const report = await service.apply(incoming);
    expect(recipes[0].terminals[0].env).toEqual({ DB_PASSWORD: "host", PORT: "2" });
    expect(report.sections.find((s) => s.section === "globalRecipes")?.leaves).toEqual([
      { key: "r1", status: "applied" },
    ]);
    // A second copy of the same thing changes nothing.
    const [again] = await service.preview(incoming);
    expect(again).toMatchObject({ update: 0, unchanged: 1 });
  });
});

describe("custom agents and shortcuts as the host reads them", () => {
  it("notes a custom agent whose CLI the host can't find, and still copies it", async () => {
    storeState.current.userAgentRegistry = {};
    const [preview] = await makeService({ commandAvailable: async () => false }).preview({
      userAgentRegistry: {
        mine: {
          id: "mine",
          name: "Mine",
          command: "mine-cli",
          color: "#112233",
          iconId: "bot",
          supportsContextInjection: true,
        },
      },
    });
    expect(preview.changes).toEqual([
      expect.objectContaining({ key: "mine", kind: "add", note: expect.stringContaining("CLI") }),
    ]);
  });

  it("reads Mac shortcuts the way a Linux host will", async () => {
    const [preview] = await makeService({ platform: "linux" }).preview({
      keybindingOverrides: { "panel.someAction": ["Cmd+Alt+T"] },
    });
    expect(preview.changes[0]).toMatchObject({
      to: "Ctrl+Alt+T",
      note: expect.stringContaining("kept clear on Linux"),
    });
  });
});
