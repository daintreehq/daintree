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
  buildMcpConfirmPreview,
  mcpConfirmPreviewTitle,
  resolveMcpConfirmPreviewTarget,
  tagMcpSpawnSource,
  useMcpBridge,
} from "../useMcpBridge";

const TOKEN = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const PRESET_ACTIONS = ["agent.createPreset", "agent.updatePreset", "agent.deletePreset"] as const;

function presetEntry(id: (typeof PRESET_ACTIONS)[number]): ActionManifestEntry {
  return {
    id,
    name: id,
    title: "Preset write",
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

function storedWork(codexHome: string): AgentSettings {
  return {
    agents: {
      codex: { customPresets: [{ id: "user-work", name: "Work", env: { CODEX_HOME: codexHome } }] },
    },
  };
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
    seedSettings(storedWork("/a"));
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

  async function openDialog(actionId: (typeof PRESET_ACTIONS)[number], args: unknown) {
    mocks.get.mockReturnValue(presetEntry(actionId));
    renderHook(() => useMcpBridge());
    const dispatched = dispatchHandler?.({
      requestId: "req",
      actionId,
      args,
      sessionOrigin: "help",
    });
    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.previewPending).toBe(false);
    });
    // Wrapped: an async function returning the promise would wait on it.
    return { dispatched };
  }

  it("refuses a write the sanitiser would change before anyone is asked", async () => {
    mocks.get.mockReturnValue(presetEntry("agent.createPreset"));
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

  it("previews the exact preset, masked, and dispatches the caller's args only once approved", async () => {
    mocks.dispatch.mockResolvedValue({ ok: true, result: { presetId: "user-x", name: "Work 2" } });
    const args = Object.freeze({
      agentId: "codex",
      name: "Work 2",
      env: Object.freeze({ CODEX_HOME: "/b", OPENAI_API_KEY: TOKEN }),
    });
    const { dispatched } = await openDialog("agent.createPreset", args);

    const pending = useMcpConfirmStore.getState().current;
    expect(pending?.subject).toBe("Work 2");
    expect(pending?.previewTitle).toBe("Preset to be created");
    const preview = (pending?.preview ?? []).join("\n");
    expect(preview).toContain('CODEX_HOME = "/b"');
    expect(preview).not.toContain(TOKEN);
    expect(pending?.argsSummary).not.toContain(TOKEN);
    expect(mocks.dispatch).not.toHaveBeenCalled();

    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    // No spawn provenance or focus policy: the strict schema would refuse them.
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "agent.createPreset",
      { agentId: "codex", name: "Work 2", env: { CODEX_HOME: "/b", OPENAI_API_KEY: TOKEN } },
      expect.objectContaining({ source: "agent", confirmed: true })
    );
    expect(sendDispatchActionResponse).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req", confirmationDecision: "approved" })
    );
  });

  it("writes nothing when the user rejects", async () => {
    const { dispatched } = await openDialog("agent.deletePreset", {
      agentId: "codex",
      presetId: "user-work",
    });
    useMcpConfirmStore.getState().resolveCurrent("rejected");
    await dispatched;
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("refuses an approval when the preset changed while the dialog was open", async () => {
    const { dispatched } = await openDialog("agent.deletePreset", {
      agentId: "codex",
      presetId: "user-work",
    });
    expect((useMcpConfirmStore.getState().current?.preview ?? []).join("\n")).toContain(
      'CODEX_HOME = "/a"'
    );

    // Another view edits the preset the user is looking at.
    seedSettings(storedWork("/elsewhere"));
    useMcpConfirmStore.getState().resolveCurrent("approved");
    await dispatched;

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(sendDispatchActionResponse).toHaveBeenCalledWith({
      requestId: "req",
      result: {
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED", message: expect.stringContaining("changed") },
      },
      confirmationDecision: "approved",
    });
  });

  it("leaves a pre-authorized write to the action, which refuses it there", async () => {
    mocks.get.mockReturnValue(presetEntry("agent.createPreset"));
    mocks.dispatch.mockResolvedValue({
      ok: false,
      error: { code: "VALIDATION_ERROR", message: "x" },
    });
    renderHook(() => useMcpBridge());
    const args = { agentId: "codex", name: "Work 2", env: { PATH: "/evil" } };

    await dispatchHandler?.({
      requestId: "req-granted",
      actionId: "agent.createPreset",
      args,
      confirmed: true,
    });

    expect(useMcpConfirmStore.getState().current).toBeNull();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "agent.createPreset",
      args,
      expect.objectContaining({ confirmed: true })
    );
  });

  it("resolves an edit's preview against the stored preset, and none for a preset it can't find", async () => {
    const target = resolveMcpConfirmPreviewTarget(
      "agent.updatePreset",
      { agentId: "codex", presetId: "user-work", envSet: { CODEX_HOME: "/c" } },
      undefined
    );
    if (target?.kind !== "agentPreset") throw new Error("expected a preset preview");
    expect(mcpConfirmPreviewTitle(target)).toBe("Changes to this preset");
    const { lines } = await buildMcpConfirmPreview(target);
    expect(lines).toContain('  CODEX_HOME: "/a" → "/c"');

    const removal = resolveMcpConfirmPreviewTarget(
      "agent.deletePreset",
      { agentId: "codex", presetId: "user-work" },
      undefined
    );
    if (removal?.kind !== "agentPreset") throw new Error("expected a preset preview");
    expect(mcpConfirmPreviewTitle(removal)).toBe("Preset to be removed");

    expect(
      resolveMcpConfirmPreviewTarget(
        "agent.deletePreset",
        { agentId: "codex", presetId: "user-gone" },
        undefined
      )
    ).toBeUndefined();
  });

  it.each(PRESET_ACTIONS)("leaves %s out of spawn tagging, unlike the agent launches", (id) => {
    const args = Object.freeze({ agentId: "codex", presetId: "user-work", name: "Work" });
    expect(tagMcpSpawnSource(id, args, "help")).toEqual({
      agentId: "codex",
      presetId: "user-work",
      name: "Work",
    });
    expect(tagMcpSpawnSource("agent.launch", { agentId: "codex" }, "help")).toMatchObject({
      spawnedBy: "assistant",
    });
  });
});
