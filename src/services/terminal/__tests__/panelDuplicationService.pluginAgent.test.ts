// A plugin agent runs through the real registry and command builder here, since
// what's under test is which ids reach the copy's command (#16470).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import {
  clearPluginAgentRegistryForTests,
  registerPluginAgents,
} from "@shared/config/pluginAgentRegistry";
import type { PluginAgentContribution } from "@shared/types/plugin";

vi.mock("@/clients", () => ({
  agentSettingsClient: { get: vi.fn() },
  systemClient: { getTmpDir: vi.fn().mockResolvedValue("/tmp") },
}));

vi.mock("@/store/ccrPresetsStore", () => ({
  useCcrPresetsStore: { getState: vi.fn(() => ({ ccrPresetsByAgent: {} })) },
}));

vi.mock("@/store/projectPresetsStore", () => ({
  useProjectPresetsStore: { getState: vi.fn(() => ({ presetsByAgent: {} })) },
}));

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

const PI: PluginAgentContribution = {
  id: "pi",
  name: "Pi",
  command: "pi",
  args: ["--no-banner"],
  color: "#3366ff",
  iconId: "terminal",
  resume: {
    kind: "session-id",
    args: ["--session-id", "{sessionId}"],
    assignSessionIdArgs: ["--session-id", "{sessionId}"],
    quitCommand: "/quit",
    resumeLatestArgs: ["--continue"],
  },
};

function piPane(overrides: Partial<PtyPanelData> = {}): PanelInstance {
  return {
    id: "pi-1",
    title: "Pi",
    location: "grid",
    kind: "terminal",
    cwd: "/repo",
    launchAgentId: "pi",
    agentSessionId: SOURCE_ID,
    command: `pi --no-banner --session-id '${SOURCE_ID}'`,
    ...overrides,
  } as PanelInstance;
}

describe("duplicating a plugin agent's pane (#16470)", () => {
  let getSettings: ReturnType<typeof vi.fn>;
  let buildPanelDuplicateOptions: typeof import("../panelDuplicationService").buildPanelDuplicateOptions;
  let buildPanelSnapshotOptions: typeof import("../panelDuplicationService").buildPanelSnapshotOptions;

  beforeEach(async () => {
    registerPluginAgents("digitalfrontier.agents", [PI]);
    const { agentSettingsClient } = await import("@/clients");
    getSettings = agentSettingsClient.get as ReturnType<typeof vi.fn>;
    getSettings.mockReset();
    getSettings.mockResolvedValue({ agents: {} });
    ({ buildPanelDuplicateOptions, buildPanelSnapshotOptions } =
      await import("../panelDuplicationService"));
  });

  afterEach(() => {
    clearPluginAgentRegistryForTests();
  });

  it("gives the copy its own id, on its command and its record", async () => {
    const options = await buildPanelDuplicateOptions(piPane(), "grid");

    expect(options.command).not.toContain(SOURCE_ID);
    expect(options.agentSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(options.agentSessionId).not.toBe(SOURCE_ID);
    expect(options.command).toContain(`--session-id '${options.agentSessionId}'`);
    // Rebuilt from the plugin's own declaration, so its args ride along.
    expect(options.command).toMatch(/^pi --no-banner /);
  });

  it("gives two copies of one pane different ids", async () => {
    const [first, second] = await Promise.all([
      buildPanelDuplicateOptions(piPane(), "grid"),
      buildPanelDuplicateOptions(piPane(), "grid"),
    ]);

    expect(first.agentSessionId).not.toBe(second.agentSessionId);
  });

  it("drops the source's id when settings can't be read to rebuild the command", async () => {
    getSettings.mockRejectedValue(new Error("settings unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const options = await buildPanelDuplicateOptions(piPane(), "grid");

    expect(options.command).toBe("pi --no-banner");
    expect(options.agentSessionId).toBeUndefined();
    warn.mockRestore();
  });

  it("keeps the reopened pane off the closed one's id", () => {
    const options = buildPanelSnapshotOptions(piPane());

    expect(options?.command).toBe("pi --no-banner");
  });

  it("copies a plugin agent that assigns no ids exactly as before", async () => {
    registerPluginAgents("digitalfrontier.agents", [
      {
        ...PI,
        resume: {
          kind: "session-id",
          args: ["--session", "{sessionId}"],
          quitCommand: "/quit",
          resumeLatestArgs: ["--continue"],
        },
      },
    ]);

    const options = await buildPanelDuplicateOptions(
      piPane({ agentSessionId: undefined, command: "pi --no-banner" }),
      "grid"
    );

    expect(options.agentSessionId).toBeUndefined();
    expect(options.command).toBe("pi --no-banner");
  });

  it("refuses a copy that would share the id when its plugin has gone", async () => {
    clearPluginAgentRegistryForTests();

    await expect(buildPanelDuplicateOptions(piPane(), "grid")).rejects.toThrow(
      /Cannot duplicate agent terminal/
    );
  });

  it("still copies a gone plugin's pane whose command holds no id", async () => {
    clearPluginAgentRegistryForTests();

    const options = await buildPanelDuplicateOptions(
      piPane({ agentSessionId: undefined, command: "pi --no-banner" }),
      "grid"
    );

    expect(options.command).toBe("pi --no-banner");
  });
});
