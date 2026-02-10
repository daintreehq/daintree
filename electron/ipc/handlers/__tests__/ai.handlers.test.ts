import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => ({ agents: {} })),
  set: vi.fn(),
}));

const getHelpMock = vi.hoisted(() => vi.fn());
const getRegistryMock = vi.hoisted(() => vi.fn(() => ({})));
const addAgentMock = vi.hoisted(() => vi.fn(() => ({ success: true })));
const updateAgentMock = vi.hoisted(() => vi.fn(() => ({ success: true })));
const removeAgentMock = vi.hoisted(() => vi.fn(() => ({ success: true })));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
}));

vi.mock("../../../store.js", () => ({
  store: storeMock,
}));

vi.mock("../../../services/AgentHelpService.js", () => ({
  AgentHelpService: class {
    getHelp = getHelpMock;
  },
}));

vi.mock("../../../services/UserAgentRegistryService.js", () => ({
  UserAgentRegistryService: class {
    getRegistry = getRegistryMock;
    addAgent = addAgentMock;
    updateAgent = updateAgentMock;
    removeAgent = removeAgentMock;
  },
}));

import { CHANNELS } from "../../channels.js";
import { registerAiHandlers } from "../ai.js";

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

describe("ai handler payload validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerAiHandlers({} as never);
  });

  it("rejects AGENT_SETTINGS_SET payload with non-string agentType", async () => {
    const handler = getInvokeHandler(CHANNELS.AGENT_SETTINGS_SET);

    await expect(
      handler(
        {} as never,
        {
          agentType: { bad: true },
          settings: { enabled: true },
        } as never
      )
    ).rejects.toThrow("Invalid agentType");

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects AGENT_SETTINGS_SET payload with reserved agentType key", async () => {
    const handler = getInvokeHandler(CHANNELS.AGENT_SETTINGS_SET);

    await expect(
      handler(
        {} as never,
        {
          agentType: "__proto__",
          settings: { enabled: true },
        } as never
      )
    ).rejects.toThrow("reserved key");

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects AGENT_SETTINGS_SET payload with non-object settings", async () => {
    const handler = getInvokeHandler(CHANNELS.AGENT_SETTINGS_SET);

    await expect(
      handler(
        {} as never,
        {
          agentType: "claude",
          settings: ["invalid"],
        } as never
      )
    ).rejects.toThrow("Invalid settings object");

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects AGENT_SETTINGS_RESET payload with non-string agentType", async () => {
    const handler = getInvokeHandler(CHANNELS.AGENT_SETTINGS_RESET);

    await expect(handler({} as never, { bad: true } as never)).rejects.toThrow("Invalid agentType");
  });

  it("rejects USER_AGENT_REGISTRY_UPDATE payload with invalid id/config types", async () => {
    const handler = getInvokeHandler(CHANNELS.USER_AGENT_REGISTRY_UPDATE);

    await expect(
      handler(
        {} as never,
        {
          id: 42,
          config: {},
        } as never
      )
    ).rejects.toThrow("Invalid id");

    await expect(
      handler(
        {} as never,
        {
          id: "custom-agent",
          config: "not-an-object",
        } as never
      )
    ).rejects.toThrow("Invalid config");

    expect(updateAgentMock).not.toHaveBeenCalled();
  });

  it("normalizes malformed stored agent settings in AGENT_SETTINGS_SET", async () => {
    const handler = getInvokeHandler(CHANNELS.AGENT_SETTINGS_SET);
    (storeMock.get as Mock).mockImplementation((key: string, defaultValue?: unknown) => {
      if (key === "agentSettings") {
        return "corrupted-settings";
      }
      return defaultValue;
    });

    const result = await handler(
      {} as never,
      {
        agentType: "claude",
        settings: { enabled: false, customFlags: "--foo" },
      } as never
    );

    expect(storeMock.set).toHaveBeenCalledWith(
      "agentSettings",
      expect.objectContaining({
        agents: {
          claude: {
            enabled: false,
            customFlags: "--foo",
          },
        },
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        agents: expect.objectContaining({
          claude: expect.objectContaining({
            enabled: false,
          }),
        }),
      })
    );
  });

  it("normalizes malformed stored agent settings in AGENT_SETTINGS_RESET", async () => {
    const handler = getInvokeHandler(CHANNELS.AGENT_SETTINGS_RESET);
    (storeMock.get as Mock).mockImplementation((key: string, defaultValue?: unknown) => {
      if (key === "agentSettings") {
        return {
          misc: true,
          agents: 42,
        };
      }
      return defaultValue;
    });

    const result = await handler({} as never, "claude");

    expect(storeMock.set).toHaveBeenCalledWith(
      "agentSettings",
      expect.objectContaining({
        misc: true,
        agents: expect.objectContaining({
          claude: expect.objectContaining({
            enabled: true,
          }),
        }),
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        misc: true,
        agents: expect.objectContaining({
          claude: expect.objectContaining({
            enabled: true,
          }),
        }),
      })
    );
  });

  it("trims AGENT_SETTINGS_SET agentType and blocks reserved values after trimming", async () => {
    const handler = getInvokeHandler(CHANNELS.AGENT_SETTINGS_SET);

    await expect(
      handler(
        {} as never,
        {
          agentType: " __proto__ ",
          settings: { enabled: true },
        } as never
      )
    ).rejects.toThrow("reserved key");

    const result = await handler(
      {} as never,
      {
        agentType: " claude ",
        settings: { enabled: false },
      } as never
    );

    expect(storeMock.set).toHaveBeenCalledWith(
      "agentSettings",
      expect.objectContaining({
        agents: {
          claude: expect.objectContaining({
            enabled: false,
          }),
        },
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        agents: expect.objectContaining({
          claude: expect.objectContaining({
            enabled: false,
          }),
        }),
      })
    );
  });

  it("trims AGENT_SETTINGS_RESET agentType and blocks reserved values after trimming", async () => {
    const handler = getInvokeHandler(CHANNELS.AGENT_SETTINGS_RESET);

    await expect(handler({} as never, " constructor " as never)).rejects.toThrow("reserved key");

    await handler({} as never, " claude ");

    expect(storeMock.set).toHaveBeenCalledWith(
      "agentSettings",
      expect.objectContaining({
        agents: expect.objectContaining({
          claude: expect.objectContaining({
            enabled: true,
          }),
        }),
      })
    );
  });
});
