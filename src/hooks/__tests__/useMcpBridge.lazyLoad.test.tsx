// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionManifestEntry } from "@shared/types/actions";
import { __resetMcpConfirmStoreForTesting, useMcpConfirmStore } from "@/store/mcpConfirmStore";

// Each factory runs only when its module is first imported, so the counters
// record what the bridge loads and when.
const loaded = vi.hoisted(() => ({ modules: [] as string[] }));
const mocks = vi.hoisted(() => ({
  get: vi.fn((_id: string): ActionManifestEntry | null => null),
  dispatch: vi.fn(),
  getContext: vi.fn((): Record<string, unknown> => ({})),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    listForTransfer: () => [],
    getDispatchMeta: mocks.get,
    dispatch: mocks.dispatch,
    getContext: mocks.getContext,
  },
}));

vi.mock("@/components/Git/gitRemoteOperationPreview", () => {
  loaded.modules.push("git");
  return {};
});
vi.mock("@/components/TerminalRecipe/recipeConfirmPreview", () => {
  loaded.modules.push("recipe");
  return {};
});
vi.mock("@/components/Forge/forgeWritePreview", () => {
  loaded.modules.push("forge");
  return {};
});
vi.mock("@/components/Worktree/worktreeDeletePreview", () => {
  loaded.modules.push("worktreeDelete");
  return {};
});
vi.mock("@/lib/mcpStartHeldPreview", () => {
  loaded.modules.push("startHeld");
  return {};
});
vi.mock("@/lib/mcpAgentPresetPreview", () => {
  loaded.modules.push("presetPreview");
  return {};
});
vi.mock("@/services/actions/definitions/agentPresetMutation", () => {
  loaded.modules.push("presetMutation");
  return {};
});
vi.mock("@/services/actions/definitions/agentPresetSources", () => {
  loaded.modules.push("presetSources");
  return {};
});
vi.mock("@/lib/mcpTerminalLaunchPreview", () => {
  loaded.modules.push("terminalLaunch");
  return { formatTerminalLaunchPreviewLines: () => ["Runs: npm run deploy"] };
});

import { useMcpBridge } from "../useMcpBridge";

type DispatchPayload = { requestId: string; actionId: string; args?: unknown; confirmed?: boolean };

// Imports evaluate before this line and before any `beforeEach`, so this is
// what loading the bridge itself pulled in.
const loadedByImport = [...loaded.modules];

describe("the bridge's on-demand modules", () => {
  let dispatchHandler: ((payload: DispatchPayload) => void | Promise<void>) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetMcpConfirmStoreForTesting();
    dispatchHandler = undefined;
    loaded.modules.length = 0;
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
          sendDispatchActionResponse: vi.fn(),
        },
        mcpServer: { holdDispatch: vi.fn(async () => ({ held: true, remainingMs: 30_000 })) },
      },
    });
  });

  const entry = (id: string, danger: ActionManifestEntry["danger"]): ActionManifestEntry => ({
    id,
    name: id,
    title: id,
    description: id,
    category: "terminal",
    kind: "command",
    danger,
    enabled: true,
    requiresArgs: false,
  });

  it("loads none of them with the bridge's own imports", () => {
    expect(loadedByImport).toEqual([]);
  });

  it("loads none of them on mount or for an ordinary dispatch", async () => {
    mocks.get.mockReturnValue(entry("terminal.list", "safe"));
    mocks.dispatch.mockResolvedValue({ ok: true, result: [] });
    renderHook(() => useMcpBridge());
    expect(dispatchHandler).toBeDefined();

    await dispatchHandler?.({ requestId: "req-list", actionId: "terminal.list", args: {} });

    expect(mocks.dispatch).toHaveBeenCalled();
    expect(loaded.modules).toEqual([]);
  });

  it("loads only the preview a confirmation needs, when it is raised", async () => {
    mocks.get.mockReturnValue(entry("terminal.new", "confirm"));
    renderHook(() => useMcpBridge());
    expect(loaded.modules).toEqual([]);

    void dispatchHandler?.({
      requestId: "req-launch",
      actionId: "terminal.new",
      args: { command: "npm run deploy" },
    });
    await vi.waitFor(() => {
      expect(useMcpConfirmStore.getState().current?.preview).toEqual(["Runs: npm run deploy"]);
    });

    expect(loaded.modules).toEqual(["terminalLaunch"]);
  });
});
