import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import type { ActionContext } from "@shared/types/actions";

// Mock the modules registerAgentActions imports so the registry builds in a node
// test env; only the bookmark actions' collaborators (panel store, window.electron)
// carry behavior for these tests.
const panelStoreMock = vi.hoisted(() => ({ getState: vi.fn() }));
const currentViewStoreMock = vi.hoisted(() => ({ getCurrentViewStore: vi.fn() }));
const worktreeSelectionMock = vi.hoisted(() => ({
  useWorktreeSelectionStore: { getState: vi.fn(() => ({ activeWorktreeId: null })) },
}));
const agentRegistryMock = vi.hoisted(() => ({
  AGENT_REGISTRY: { claude: { name: "Claude" } },
  getAgentDisplayTitle: vi.fn((id: string) => `Title:${id}`),
}));
const clientsMock = vi.hoisted(() => ({
  agentSettingsClient: { get: vi.fn() },
  cliAvailabilityClient: { get: vi.fn() },
  agentCapabilitiesClient: { getRegistry: vi.fn() },
  userAgentRegistryClient: { get: vi.fn() },
}));
const agentSettingsStoreMock = vi.hoisted(() => ({ useAgentSettingsStore: { getState: vi.fn() } }));
const cliAvailabilityStoreMock = vi.hoisted(() => ({
  useCliAvailabilityStore: { getState: vi.fn() },
}));

vi.mock("@/store/panelStore", () => ({ usePanelStore: panelStoreMock }));
vi.mock("@/store/createWorktreeStore", () => currentViewStoreMock);
vi.mock("@/store/worktreeStore", () => worktreeSelectionMock);
vi.mock("@/store/agentSettingsStore", () => agentSettingsStoreMock);
vi.mock("@/store/cliAvailabilityStore", () => cliAvailabilityStoreMock);
vi.mock("@/config/agents", () => agentRegistryMock);
vi.mock("@/clients/userAgentRegistryClient", () => ({
  userAgentRegistryClient: clientsMock.userAgentRegistryClient,
}));
vi.mock("@/clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients")>();
  return {
    ...actual,
    agentSettingsClient: clientsMock.agentSettingsClient,
    cliAvailabilityClient: clientsMock.cliAvailabilityClient,
    agentCapabilitiesClient: clientsMock.agentCapabilitiesClient,
  };
});

import { registerAgentActions } from "../agentActions";

const agentSessionHistoryMock = {
  prepareBookmark: vi.fn(),
  promoteBookmark: vi.fn(),
  renameBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  listBookmarks: vi.fn(),
};

function setupActions(): ActionRegistry {
  const actions: ActionRegistry = new Map();
  registerAgentActions(actions, {} as ActionCallbacks);
  return actions;
}

function callAction(
  actions: ActionRegistry,
  id: string,
  args?: unknown,
  ctx: Partial<ActionContext> = {}
): Promise<unknown> {
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  const def = factory() as AnyActionDefinition;
  return def.run(args, ctx as ActionContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", { electron: { agentSessionHistory: agentSessionHistoryMock } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session bookmark actions", () => {
  it("bookmarkAndClose captures the pane's metadata, then removes the pane without a second kill", async () => {
    const record = {
      sessionId: "s1",
      agentId: "claude",
      bookmark: { bookmarkedAt: 1, label: "L" },
    };
    agentSessionHistoryMock.prepareBookmark.mockResolvedValue({ record });
    const removePanel = vi.fn();
    panelStoreMock.getState.mockReturnValue({
      getTerminal: vi.fn(() => ({
        id: "term-1",
        kind: "terminal",
        titleMode: "user",
        agentPresetId: "preset-1",
        agentPresetColor: "#abc",
        originalPresetId: "preset-0",
        isUsingFallback: true,
        fallbackChainIndex: 2,
        isInputLocked: false,
      })),
      removePanel,
    });

    const actions = setupActions();
    const result = await callAction(actions, "session.bookmarkAndClose", {
      terminalId: "term-1",
      label: "L",
    });

    expect(agentSessionHistoryMock.prepareBookmark).toHaveBeenCalledWith({
      terminalId: "term-1",
      label: "L",
      metadata: {
        sourcePanelId: "term-1",
        titleMode: "user",
        agentPresetId: "preset-1",
        agentPresetColor: "#abc",
        originalPresetId: "preset-0",
        isUsingFallback: true,
        fallbackChainIndex: 2,
        isInputLocked: false,
      },
    });
    expect(removePanel).toHaveBeenCalledWith("term-1", { backendAlreadyClosed: true });
    expect(result).toEqual({ record });
  });

  it("bookmarkAndClose leaves the pane open when capture fails", async () => {
    agentSessionHistoryMock.prepareBookmark.mockRejectedValue(new Error("SESSION_CAPTURE_FAILED"));
    const removePanel = vi.fn();
    panelStoreMock.getState.mockReturnValue({
      getTerminal: vi.fn(() => ({ id: "term-1", kind: "terminal" })),
      removePanel,
    });

    const actions = setupActions();
    await expect(
      callAction(actions, "session.bookmarkAndClose", { terminalId: "term-1", label: "L" })
    ).rejects.toThrow(/SESSION_CAPTURE_FAILED/);
    expect(removePanel).not.toHaveBeenCalled();
  });

  it("promote and rename forward the exact sessionId and label", async () => {
    const record = { sessionId: "s1" };
    agentSessionHistoryMock.promoteBookmark.mockResolvedValue(record);
    agentSessionHistoryMock.renameBookmark.mockResolvedValue(record);
    const actions = setupActions();

    await callAction(actions, "session.bookmark.promote", { sessionId: "s1", label: "P" });
    expect(agentSessionHistoryMock.promoteBookmark).toHaveBeenCalledWith({
      sessionId: "s1",
      label: "P",
    });

    await callAction(actions, "session.bookmark.rename", { sessionId: "s1", label: "R" });
    expect(agentSessionHistoryMock.renameBookmark).toHaveBeenCalledWith({
      sessionId: "s1",
      label: "R",
    });
  });

  it("delete forwards only the sessionId", async () => {
    agentSessionHistoryMock.deleteBookmark.mockResolvedValue(undefined);
    const actions = setupActions();
    await callAction(actions, "session.bookmark.delete", { sessionId: "s1" });
    expect(agentSessionHistoryMock.deleteBookmark).toHaveBeenCalledWith({ sessionId: "s1" });
  });

  it("list scopes to the explicit projectId, then the context project, and wraps the result", async () => {
    agentSessionHistoryMock.listBookmarks.mockResolvedValue([{ sessionId: "s1" }]);
    const actions = setupActions();

    // Explicit arg wins.
    await callAction(
      actions,
      "session.bookmarks.list",
      { projectId: "explicit" },
      { projectId: "ctx" }
    );
    expect(agentSessionHistoryMock.listBookmarks).toHaveBeenLastCalledWith({
      projectId: "explicit",
    });

    // Falls back to the context project.
    const wrapped = await callAction(actions, "session.bookmarks.list", undefined, {
      projectId: "ctx",
    });
    expect(agentSessionHistoryMock.listBookmarks).toHaveBeenLastCalledWith({ projectId: "ctx" });
    expect(wrapped).toEqual({ bookmarks: [{ sessionId: "s1" }] });

    // No scope at all lists across projects.
    await callAction(actions, "session.bookmarks.list", undefined, {});
    expect(agentSessionHistoryMock.listBookmarks).toHaveBeenLastCalledWith(undefined);
  });
});
