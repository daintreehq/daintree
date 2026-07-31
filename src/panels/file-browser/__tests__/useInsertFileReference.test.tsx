// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const WORKSPACE_ID = "ws-1";

const { getViewWorkspaceIdMock } = vi.hoisted(() => ({
  getViewWorkspaceIdMock: vi.fn<() => string | null>(() => WORKSPACE_ID),
}));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: getViewWorkspaceIdMock }));

// The real store graph pulls the whole app in; these four are all the hook
// reads, and driving them directly is what makes the refusal matrix legible.
const { asStore, panelState, inputState, fleetState, projectState } = vi.hoisted(() => ({
  // Stands in for a Zustand hook: callable with a selector and carrying
  // `getState`, which is the only shape this hook uses.
  asStore: <S,>(state: S) => {
    const hook = (selector: (s: S) => unknown) => selector(state);
    hook.getState = () => state;
    return hook;
  },
  panelState: {
    panelsById: {} as Record<string, unknown>,
    panelIds: [] as string[],
    backendStatus: "connected" as string,
    pingTerminal: vi.fn<(id: string) => void>(),
  },
  inputState: {
    hybridInputEnabled: true,
    voiceSubmittingPanels: new Set<string>(),
    lastTypedAgentTarget: null as { workspaceId: string; terminalId: string } | null,
    getDraftInput: vi.fn<(id: string, projectId?: string) => string>(() => ""),
    setDraftInput: vi.fn<(id: string, value: string, projectId?: string) => void>(),
    bumpExternalDraftRevision: vi.fn(),
    recordLastTypedAgentTarget: vi.fn(),
  },
  fleetState: { armedIds: new Set<string>() },
  projectState: { currentProject: { id: "proj-1" } as { id: string } | undefined },
}));

vi.mock("@/store", () => ({ usePanelStore: asStore(panelState) }));
vi.mock("@/store/terminalInputStore", () => ({ useTerminalInputStore: asStore(inputState) }));
vi.mock("@/store/fleetArmingStore", () => ({ useFleetArmingStore: asStore(fleetState) }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: asStore(projectState) }));

const { showLocatorMock, announceMock } = vi.hoisted(() => ({
  showLocatorMock: vi.fn<(label: string) => void>(),
  announceMock: vi.fn<(msg: string, priority?: string) => void>(),
}));
vi.mock("@/store/typingLocatorStore", () => ({
  useTypingLocatorStore: asStore({ showLocator: showLocatorMock }),
}));
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: asStore({ announce: announceMock }),
}));

import type { PtyPanelData } from "@shared/types/panel";
import { useInsertFileReference } from "../useInsertFileReference";

/**
 * Mirrors the fixture `typeAnywhere.test.ts` uses: PTY panels are
 * `kind: "terminal"` and agent identity is derived from `launchAgentId`, not a
 * bare `agentId` field. A panel missing `hasPty`/`runtimeStatus` silently
 * fails `isAgentFleetActionEligible` for the wrong reason.
 */
function agentPanel(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: "Claude",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    hasPty: true,
    runtimeStatus: "running",
    launchAgentId: "claude",
    ...overrides,
  };
}

function seedPanels(...panels: PtyPanelData[]): void {
  panelState.panelsById = Object.fromEntries(panels.map((p) => [p.id, p]));
  panelState.panelIds = panels.map((p) => p.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  getViewWorkspaceIdMock.mockReturnValue(WORKSPACE_ID);
  panelState.backendStatus = "connected";
  inputState.hybridInputEnabled = true;
  inputState.voiceSubmittingPanels = new Set();
  inputState.lastTypedAgentTarget = null;
  inputState.getDraftInput.mockReturnValue("");
  fleetState.armedIds = new Set();
  projectState.currentProject = { id: "proj-1" };
  seedPanels(agentPanel("t-1"));
});

describe("useInsertFileReference — target resolution", () => {
  it("routes to the recorded agent even when other agents are open", () => {
    seedPanels(agentPanel("t-1"), agentPanel("t-2"));
    inputState.lastTypedAgentTarget = { workspaceId: WORKSPACE_ID, terminalId: "t-2" };

    const { result } = renderHook(() => useInsertFileReference());
    expect(result.current.canInsert).toBe(true);
    act(() => {
      result.current.insert("/repo/a.ts");
    });

    expect(inputState.setDraftInput).toHaveBeenCalledWith("t-2", "@/repo/a.ts ", "proj-1");
  });

  it("falls back to the sole open agent when nothing was typed yet", () => {
    const { result } = renderHook(() => useInsertFileReference());
    act(() => {
      result.current.insert("/repo/a.ts");
    });
    expect(inputState.setDraftInput).toHaveBeenCalledWith("t-1", "@/repo/a.ts ", "proj-1");
  });

  it("refuses rather than guessing between two agents with no history", () => {
    seedPanels(agentPanel("t-1"), agentPanel("t-2"));
    const { result } = renderHook(() => useInsertFileReference());
    expect(result.current.canInsert).toBe(false);
    act(() => {
      expect(result.current.insert("/repo/a.ts")).toBe(false);
    });
    expect(inputState.setDraftInput).not.toHaveBeenCalled();
  });

  it("refuses a target recorded by a sibling view", () => {
    seedPanels(agentPanel("t-1"), agentPanel("t-2"));
    inputState.lastTypedAgentTarget = { workspaceId: "ws-other", terminalId: "t-2" };

    const { result } = renderHook(() => useInsertFileReference());
    // Ambiguous once the foreign record is discarded — it must not fall
    // through to a different agent's draft.
    expect(result.current.canInsert).toBe(false);
  });

  it("refuses when the known target cannot take input, instead of falling through", () => {
    seedPanels(agentPanel("t-1"), agentPanel("t-2", { isInputLocked: true }));
    inputState.lastTypedAgentTarget = { workspaceId: WORKSPACE_ID, terminalId: "t-2" };

    const { result } = renderHook(() => useInsertFileReference());
    expect(result.current.canInsert).toBe(false);
    act(() => {
      result.current.insert("/repo/a.ts");
    });
    expect(inputState.setDraftInput).not.toHaveBeenCalled();
  });

  it.each([
    ["a restarting target", () => seedPanels(agentPanel("t-1", { isRestarting: true }))],
    ["an exited target", () => seedPanels(agentPanel("t-1", { runtimeStatus: "exited" }))],
    [
      "a raw shell with no agent identity",
      () => seedPanels(agentPanel("t-1", { launchAgentId: undefined })),
    ],
    ["a docked target", () => seedPanels(agentPanel("t-1", { location: "dock" }))],
  ])("refuses %s", (_label, seed) => {
    seed();
    const { result } = renderHook(() => useInsertFileReference());
    expect(result.current.canInsert).toBe(false);
  });

  it("refuses while hybrid input is switched off, since there is no draft bar to show", () => {
    inputState.hybridInputEnabled = false;
    const { result } = renderHook(() => useInsertFileReference());
    expect(result.current.canInsert).toBe(false);
  });

  it("refuses while the pty backend is down", () => {
    panelState.backendStatus = "disconnected";
    const { result } = renderHook(() => useInsertFileReference());
    expect(result.current.canInsert).toBe(false);
  });

  it("refuses while the target is mid-voice-submit", () => {
    inputState.voiceSubmittingPanels = new Set(["t-1"]);
    const { result } = renderHook(() => useInsertFileReference());
    expect(result.current.canInsert).toBe(false);
  });

  it("refuses during a live fleet broadcast but allows a single-armed preview", () => {
    fleetState.armedIds = new Set(["t-1", "t-2"]);
    expect(renderHook(() => useInsertFileReference()).result.current.canInsert).toBe(false);

    fleetState.armedIds = new Set(["t-1"]);
    expect(renderHook(() => useInsertFileReference()).result.current.canInsert).toBe(true);
  });

  it("refuses when the view has no workspace identity", () => {
    getViewWorkspaceIdMock.mockReturnValue(null);
    const { result } = renderHook(() => useInsertFileReference());
    expect(result.current.canInsert).toBe(false);
  });
});

describe("useInsertFileReference — writing", () => {
  it("appends to the existing draft rather than replacing it", () => {
    inputState.getDraftInput.mockReturnValue("look at");
    const { result } = renderHook(() => useInsertFileReference());
    act(() => {
      result.current.insert("/repo/a.ts");
    });
    expect(inputState.setDraftInput).toHaveBeenCalledWith("t-1", "look at @/repo/a.ts ", "proj-1");
  });

  it("bumps the external revision exactly once so the editor resyncs", () => {
    const { result } = renderHook(() => useInsertFileReference());
    act(() => {
      result.current.insert("/repo/a.ts");
    });
    expect(inputState.bumpExternalDraftRevision).toHaveBeenCalledTimes(1);
  });

  it("commits the draft before any feedback runs", () => {
    // A throwing reveal must not be able to lose the reference (#11147).
    const order: string[] = [];
    inputState.setDraftInput.mockImplementation(() => void order.push("write"));
    panelState.pingTerminal.mockImplementation(() => void order.push("ping"));
    showLocatorMock.mockImplementation(() => void order.push("locator"));
    announceMock.mockImplementation(() => void order.push("announce"));

    const { result } = renderHook(() => useInsertFileReference());
    act(() => {
      result.current.insert("/repo/a.ts");
    });

    expect(order[0]).toBe("write");
    expect(order).toContain("ping");
  });

  it("does not claim the routing target for the file browser", () => {
    const { result } = renderHook(() => useInsertFileReference());
    act(() => {
      result.current.insert("/repo/a.ts");
    });
    expect(inputState.recordLastTypedAgentTarget).not.toHaveBeenCalled();
  });

  it("names the destination in both the pill and the polite announcement", () => {
    seedPanels(agentPanel("t-1", { title: "Claude" }));
    const { result } = renderHook(() => useInsertFileReference());
    act(() => {
      result.current.insert("/repo/a.ts");
    });
    expect(showLocatorMock).toHaveBeenCalledWith(expect.stringContaining("Claude"));
    expect(announceMock).toHaveBeenCalledWith(expect.stringContaining("Claude"), "polite");
  });

  it("re-resolves at click time, so a target that died while the menu was open is refused", () => {
    const { result } = renderHook(() => useInsertFileReference());
    expect(result.current.canInsert).toBe(true);

    // The agent exits between render and the menu item being chosen.
    seedPanels(agentPanel("t-1", { runtimeStatus: "exited" }));
    act(() => {
      expect(result.current.insert("/repo/a.ts")).toBe(false);
    });
    expect(inputState.setDraftInput).not.toHaveBeenCalled();
  });

  it("ignores an empty path rather than writing a bare @", () => {
    const { result } = renderHook(() => useInsertFileReference());
    act(() => {
      expect(result.current.insert("")).toBe(false);
    });
    expect(inputState.setDraftInput).not.toHaveBeenCalled();
  });
});
