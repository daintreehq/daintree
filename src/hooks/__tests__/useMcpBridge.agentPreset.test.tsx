// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "@shared/types/actions";
import type { AgentSettings } from "@shared/types/agentSettings";
import { __resetMcpConfirmStoreForTesting, useMcpConfirmStore } from "@/store/mcpConfirmStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";

const mocks = vi.hoisted(() => ({
  get: vi.fn((_id: string): ActionManifestEntry | null => null),
  dispatch: vi.fn(),
  getContext: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    list: () => [],
    getDispatchMeta: mocks.get,
    dispatch: mocks.dispatch,
    getContext: mocks.getContext,
  },
}));

import {
  mcpConfirmPreviewTitle,
  resolveMcpConfirmPreviewTarget,
  tagMcpSpawnSource,
  useMcpBridge,
} from "../useMcpBridge";

const TOKEN = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

function presetEntry(id: string, title: string): ActionManifestEntry {
  return {
    id: id as ActionManifestEntry["id"],
    name: id,
    title,
    description: "A user-preset write.",
    category: "agent",
    kind: "command",
    danger: "confirm",
    enabled: true,
    requiresArgs: true,
  };
}

function seedSettings(settings: AgentSettings): void {
  // Initialized, so the bridge's load-before-plan resolves without a read.
  useAgentSettingsStore.setState({ settings, isInitialized: true, isLoading: false, error: null });
}

type DispatchPayload = {
  requestId: string;
  actionId: string;
  args?: unknown;
  confirmed?: boolean;
  sessionOrigin?: "help" | "external";
};

describe("user-preset writes through the MCP bridge (#16047)", () => {
  let dispatchHandler: ((payload: DispatchPayload) => void | Promise<void>) | undefined;
  let sendDispatchActionResponse: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetMcpConfirmStoreForTesting();
    seedSettings({
      agents: {
        codex: { customPresets: [{ id: "user-work", name: "Work", env: { CODEX_HOME: "/a" } }] },
      },
    } as AgentSettings);
    dispatchHandler = undefined;
    sendDispatchActionResponse = vi.fn();
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        mcpBridge: {
          onGetManifestRequest: () => vi.fn(),
          sendGetManifestResponse: vi.fn(),
          onDispatchActionRequest: (callback: (payload: DispatchPayload) => Promise<void>) => {
            dispatchHandler = callback;
            return vi.fn();
          },
          sendDispatchActionResponse,
        },
        mcpServer: {
          holdDispatch: vi.fn(async () => ({ held: true, remainingMs: 30_000 })),
        },
      },
    });
  });

  afterEach(() => {
    __resetMcpConfirmStoreForTesting();
    useAgentSettingsStore.setState({ settings: null, isInitialized: false });
  });

  it("refuses a write the sanitiser would change before anyone is asked", async () => {
    mocks.get.mockReturnValue(presetEntry("agent.createPreset", "Create launch preset"));
    renderHook(() => useMcpBridge());

    await dispatchHandler?.({
      requestId: "req-bad",
      actionId: "agent.createPreset",
      args: { agentId: "codex", name: "Work 2", env: { PATH: "/evil" } },
    });

    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req-bad",
      result: {
        ok: false,
        error: { code: "VALIDATION_ERROR", message: expect.stringContaining('env "PATH"') },
      },
    });
  });

  it("previews the exact preset, masked, and dispatches the caller's args untouched", async () => {
    mocks.get.mockReturnValue(presetEntry("agent.createPreset", "Create launch preset"));
    mocks.dispatch.mockResolvedValue({ ok: true, result: { presetId: "user-x", name: "Work 2" } });
    renderHook(() => useMcpBridge());

    const args = {
      agentId: "codex",
      name: "Work 2",
      env: { CODEX_HOME: "/b", OPENAI_API_KEY: TOKEN },
    };
    const dispatched = dispatchHandler?.({
      requestId: "req-ok",
      actionId: "agent.createPreset",
      args,
      sessionOrigin: "help",
    });

    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    const pending = useMcpConfirmStore.getState().current;
    expect(pending?.subject).toBe("Work 2");
    expect(pending?.previewTitle).toBe("Preset to be created");
    const preview = (pending?.preview ?? []).join("\n");
    expect(preview).toContain('CODEX_HOME = "/b"');
    expect(preview).not.toContain(TOKEN);
    expect(pending?.argsSummary).not.toContain(TOKEN);

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    // No spawn provenance or focus policy: the strict schema would refuse them.
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "agent.createPreset",
      args,
      expect.objectContaining({ source: "agent", confirmed: true })
    );
    expect(sendDispatchActionResponse).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-ok", confirmationDecision: "approved" })
    );
  });

  it("resolves an edit's preview against the stored preset, and none for a preset it can't find", () => {
    const target = resolveMcpConfirmPreviewTarget(
      "agent.updatePreset",
      { agentId: "codex", presetId: "user-work", envSet: { CODEX_HOME: "/c" } },
      undefined
    );
    expect(target?.kind).toBe("agentPreset");
    if (target?.kind !== "agentPreset") return;
    expect(target.mutation.operation === "update" && target.mutation.before.env).toEqual({
      CODEX_HOME: "/a",
    });
    expect(mcpConfirmPreviewTitle(target)).toBe("Changes to this preset");

    expect(
      resolveMcpConfirmPreviewTarget(
        "agent.deletePreset",
        { agentId: "codex", presetId: "user-gone" },
        undefined
      )
    ).toBeUndefined();
  });

  it("leaves the preset writes out of spawn tagging, unlike the agent launches", () => {
    const args = { agentId: "codex", name: "Work" };
    expect(tagMcpSpawnSource("agent.createPreset", args, "help")).toBe(args);
    expect(tagMcpSpawnSource("agent.launch", { agentId: "codex" }, "help")).toMatchObject({
      spawnedBy: "assistant",
    });
  });
});
