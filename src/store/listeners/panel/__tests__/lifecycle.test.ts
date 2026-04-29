// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCcrPresetsStore } from "@/store/ccrPresetsStore";
import { useProjectPresetsStore } from "@/store/projectPresetsStore";

const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: dispatchMock },
}));

vi.mock("@/lib/notify", () => ({
  notify: vi.fn(),
  muteForDuration: vi.fn(),
  muteUntilNextMorning: vi.fn(),
  setSessionQuietUntil: vi.fn(),
  isScheduledQuietHours: vi.fn().mockReturnValue(false),
}));

vi.mock("@/utils/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { handleFallbackTriggered } from "../lifecycle";
import { notify } from "@/lib/notify";

const actionMatcher = {
  label: "Open agent settings",
  actionId: "app.settings.openTab",
  actionArgs: { tab: "agents" },
};

function setupPanel(overrides: Record<string, unknown> = {}) {
  usePanelStore.setState({
    panelsById: {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        title: "Test Terminal",
        cwd: "/tmp",
        cols: 80,
        rows: 24,
        location: "grid" as const,
        agentPresetId: "preset-1",
        originalPresetId: "preset-1",
        fallbackChainIndex: 0,
        ...overrides,
      },
    },
    panelIds: ["term-1"],
  });
}

beforeEach(() => {
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
  useAgentSettingsStore.setState({ settings: { agents: {} } });
  useCcrPresetsStore.setState({ ccrPresetsByAgent: {} });
  useProjectPresetsStore.setState({ presetsByAgent: {} });
  dispatchMock.mockClear();
  vi.mocked(notify).mockClear();
});

describe("handleFallbackTriggered — exhausted chain", () => {
  it("emits error with recovery action when preset has a fallback chain but chain is exhausted", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              {
                id: "preset-1",
                name: "Primary",
                fallbacks: ["preset-2"],
              },
              {
                id: "preset-2",
                name: "Fallback",
              },
            ],
          },
        },
      },
    });
    setupPanel({
      agentPresetId: "preset-1",
      fallbackChainIndex: 1,
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        priority: "high",
        title: "Fallback chain exhausted",
        message: expect.stringContaining("Configure fallback presets"),
        duration: 12000,
        action: expect.objectContaining(actionMatcher),
      })
    );
  });

  it("dispatches settings navigation when action onClick is invoked", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              {
                id: "preset-1",
                name: "Primary",
                fallbacks: ["preset-2"],
              },
              {
                id: "preset-2",
                name: "Fallback",
              },
            ],
          },
        },
      },
    });
    setupPanel({
      agentPresetId: "preset-1",
      fallbackChainIndex: 1,
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    const callArgs = vi.mocked(notify).mock.lastCall?.[0];
    const action = callArgs?.action;
    expect(action).toBeDefined();
    (action!.onClick as () => void)();

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents" },
      { source: "user" }
    );
  });

  it("emits error for no-fallback preset when fromName is unavailable", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              {
                id: "preset-1",
                name: "Primary",
              },
            ],
          },
        },
      },
    });
    setupPanel({
      agentPresetId: "preset-1",
      fallbackChainIndex: 0,
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        priority: "high",
        title: "Primary unavailable",
        message: expect.stringContaining("Configure fallbacks"),
        duration: 12000,
        action: expect.objectContaining(actionMatcher),
      })
    );
  });

  it("includes recovery action onClick that dispatches app.settings.openTab", async () => {
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          testAgent: {
            customPresets: [
              {
                id: "preset-1",
                name: "Primary",
              },
            ],
          },
        },
      },
    });
    setupPanel({
      agentPresetId: "preset-1",
      fallbackChainIndex: 0,
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    const callArgs = vi.mocked(notify).mock.lastCall?.[0];
    expect(callArgs?.action?.label).toBe("Open agent settings");
    expect(callArgs?.action?.actionId).toBe("app.settings.openTab");
    expect(callArgs?.action?.actionArgs).toEqual({ tab: "agents" });
    (callArgs!.action!.onClick as () => void)();

    expect(dispatchMock).toHaveBeenCalledWith(
      "app.settings.openTab",
      { tab: "agents" },
      { source: "user" }
    );
  });
});

describe("handleFallbackTriggered — guard clauses", () => {
  it("returns early when panel is not found", async () => {
    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it("returns early when panel is restarting", async () => {
    setupPanel({ isRestarting: true });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it("returns early when preset has already changed (stale event)", async () => {
    setupPanel({
      agentPresetId: "preset-2",
    });

    await handleFallbackTriggered({
      terminalId: "term-1",
      agentId: "testAgent",
      fromPresetId: "preset-1",
      reason: "connection",
    });

    expect(notify).not.toHaveBeenCalled();
  });
});
