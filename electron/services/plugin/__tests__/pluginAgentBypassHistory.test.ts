import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => {
  let agentSettings: Record<string, unknown> | undefined;
  return {
    reset(value?: Record<string, unknown>) {
      agentSettings = value;
    },
    get: vi.fn((key: string) => (key === "agentSettings" ? agentSettings : undefined)),
    set: vi.fn((key: string, value: unknown) => {
      const [root, leaf] = key.split(".", 2);
      if (root !== "agentSettings" || leaf === undefined) throw new Error(`unexpected ${key}`);
      agentSettings = { ...agentSettings, [leaf]: value };
    }),
  };
});
const broadcastMock = vi.hoisted(() => vi.fn());

vi.mock("../../../store.js", () => ({ store: storeMock }));
vi.mock("../../../ipc/utils.js", () => ({ broadcastToRenderer: broadcastMock }));

import { CHANNELS } from "../../../ipc/channels.js";
import { recordPluginAgentBypassArgs } from "../pluginAgentBypassHistory.js";
import {
  clearPluginAgentRegistryForTests,
  getPluginAgentRegistry,
  registerPluginAgents,
  unregisterPluginAgents,
} from "../../../../shared/config/pluginAgentRegistry.js";

const history = () =>
  (storeMock.get("agentSettings") as { pluginBypassArgHistory?: unknown } | undefined)
    ?.pluginBypassArgHistory;

describe("recordPluginAgentBypassArgs (#16374)", () => {
  beforeEach(() => {
    storeMock.reset({ agents: { claude: { customFlags: "-v" } }, globalSkipPermissions: true });
    storeMock.set.mockClear();
    broadcastMock.mockClear();
  });

  it("records each declaration under its agent and tells every view", () => {
    recordPluginAgentBypassArgs([
      { id: "hermes", permissionBypassArgs: ["--yolo"] },
      { id: "atlas", permissionBypassArgs: ["--approval", "never"] },
    ]);

    expect(history()).toEqual({ hermes: [["--yolo"]], atlas: [["--approval", "never"]] });
    expect(storeMock.get("agentSettings")).toMatchObject({
      agents: { claude: { customFlags: "-v" } },
      globalSkipPermissions: true,
    });
    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(
      CHANNELS.AGENT_SETTINGS_CHANGED,
      storeMock.get("agentSettings")
    );
  });

  it("keeps an earlier declaration when an update changes it", () => {
    recordPluginAgentBypassArgs([{ id: "hermes", permissionBypassArgs: ["--yolo"] }]);
    recordPluginAgentBypassArgs([{ id: "hermes", permissionBypassArgs: ["--trust-all"] }]);

    expect(history()).toEqual({ hermes: [["--yolo"], ["--trust-all"]] });
  });

  it("writes and broadcasts nothing for a declaration it already holds, or for none", () => {
    recordPluginAgentBypassArgs([{ id: "hermes", permissionBypassArgs: ["--yolo"] }]);
    storeMock.set.mockClear();
    broadcastMock.mockClear();

    recordPluginAgentBypassArgs([
      { id: "hermes", permissionBypassArgs: ["--yolo"] },
      { id: "plain" },
      { id: "empty", permissionBypassArgs: [] },
    ]);

    expect(storeMock.set).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(history()).toEqual({ hermes: [["--yolo"]] });
  });

  it("tells an option-and-value declaration apart from the same tokens joined", () => {
    recordPluginAgentBypassArgs([{ id: "hermes", permissionBypassArgs: ["--approval", "never"] }]);
    recordPluginAgentBypassArgs([{ id: "hermes", permissionBypassArgs: ["--approval never"] }]);

    expect(history()).toEqual({ hermes: [["--approval", "never"], ["--approval never"]] });
  });

  it("drops malformed stored entries and keeps every earlier declaration", () => {
    const earlier = Array.from({ length: 40 }, (_, i) => [`--v${i}`]);
    storeMock.reset({
      pluginBypassArgHistory: { hermes: earlier, broken: "not a list", mixed: [["--ok"], [7], []] },
    });

    recordPluginAgentBypassArgs([{ id: "hermes", permissionBypassArgs: ["--newest"] }]);

    const stored = history() as Record<string, string[][]>;
    expect(stored.hermes).toEqual([...earlier, ["--newest"]]);
    expect(stored.mixed).toEqual([["--ok"]]);
    expect(Object.hasOwn(stored, "broken")).toBe(false);
  });

  it("records an agent promoted when the plugin that shadowed it unloads", () => {
    clearPluginAgentRegistryForTests();
    const agent = { name: "Hermes", command: "hermes", color: "#3366ff", iconId: "claude" };
    registerPluginAgents("a.first", [{ ...agent, id: "hermes", permissionBypassArgs: ["--yolo"] }]);
    registerPluginAgents("b.second", [
      { ...agent, id: "hermes", permissionBypassArgs: ["--trust-all"] },
    ]);
    recordPluginAgentBypassArgs(Object.values(getPluginAgentRegistry()));
    expect(history()).toEqual({ hermes: [["--yolo"]] });

    unregisterPluginAgents("a.first");
    recordPluginAgentBypassArgs(Object.values(getPluginAgentRegistry()));

    expect(history()).toEqual({ hermes: [["--yolo"], ["--trust-all"]] });
    clearPluginAgentRegistryForTests();
  });
});
