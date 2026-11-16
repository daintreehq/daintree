/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(undefined),
    onData: vi.fn(),
    onExit: vi.fn(),
    onAgentStateChanged: vi.fn(),
  },
  appClient: { setState: vi.fn().mockResolvedValue(undefined) },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: { get: vi.fn().mockResolvedValue({}) },
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    onPanelBackgrounded: vi.fn(),
    destroy: vi.fn(),
  };
  return { createTerminalPaintPlane: () => terminalInstanceService };
});

const resumeSessionForPerson = vi.fn();
vi.mock("@/services/agentResumeForPerson", () => ({
  resumeSessionForPerson: (...args: unknown[]) => resumeSessionForPerson(...args),
}));

const { usePanelStore } = await import("@/store/panelStore");
const { useProjectStore } = await import("@/store/projectStore");
const { useWorktreeSelectionStore } = await import("@/store/worktreeStore");
const { useResumedSessionPanelStore } = await import("@/store/resumedSessionPanelStore");
const history = await import("../panelCloseHistory");
const { undoLastClose, CAPTURE_WAIT_MS } = await import("../panelCloseUndo");
const { undoCloseTakesKey } = await import("../undoCloseKey");
const { trackNativeFieldEdits } = await import("../closeUndoOrder");
const { PLUGIN_STYLE_OWNER_ATTRIBUTE } = await import("@/services/plugin/pluginStyleOwner");

const listSessions =
  vi.fn<(worktreeId?: string, projectId?: string) => Promise<AgentSessionRecord[]>>();

function seed(
  id: string,
  options: { worktreeId?: string; location?: "grid" | "dock"; agent?: boolean } = {}
) {
  const panel = {
    id,
    title: id,
    kind: "terminal" as const,
    type: "terminal" as const,
    location: options.location ?? "grid",
    worktreeId: options.worktreeId ?? "wt-1",
    isVisible: true,
    ...(options.agent && {
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentState: "idle",
    }),
  } as unknown as PtyPanelData;
  usePanelStore.setState((state) => ({
    panelsById: { ...state.panelsById, [id]: panel },
    panelIds: state.panelIds.includes(id) ? state.panelIds : [...state.panelIds, id],
  }));
}

function userClose(ids: string[], commit?: () => void) {
  history.prepareUserClose(ids)(
    commit ?? (() => ids.forEach((id) => usePanelStore.getState().trashPanel(id)))
  );
}

function locationOf(id: string) {
  return usePanelStore.getState().panelsById[id]?.location;
}

function setProject(id: string) {
  useProjectStore.setState({
    currentProject: { id, name: id, path: `/p/${id}` },
  } as unknown as Parameters<typeof useProjectStore.setState>[0]);
}

beforeEach(async () => {
  await usePanelStore.getState().reset();
  history.resetPanelCloseHistoryForTests();
  // The store orchestrator connects it in the app.
  history.connectPanelCloseHistory(usePanelStore);
  setProject("proj-1");
  useWorktreeSelectionStore.setState({
    activeWorktreeId: "wt-1",
    selectWorktree: vi.fn((id: string) =>
      useWorktreeSelectionStore.setState({ activeWorktreeId: id })
    ),
  } as unknown as Parameters<typeof useWorktreeSelectionStore.setState>[0]);
  useResumedSessionPanelStore.setState({ panelIds: new Set() });
  resumeSessionForPerson.mockReset();
  listSessions.mockReset().mockResolvedValue([]);
  Reflect.set(window, "electron", {
    agentSessionHistory: { list: listSessions },
    events: { on: vi.fn(() => () => undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "electron");
  history.connectPanelCloseHistory(null);
});

describe("panel close history", () => {
  it("walks back newest first, focusing each panel it reopens", async () => {
    for (const id of ["a", "b", "c"]) seed(id);
    userClose(["a"]);
    userClose(["b"]);
    userClose(["c"]);

    for (const id of ["c", "b", "a"]) {
      await expect(undoLastClose()).resolves.toBe(true);
      expect(locationOf(id)).toBe("grid");
      expect(usePanelStore.getState().focusedId).toBe(id);
    }
    await expect(undoLastClose()).resolves.toBe(false);
  });

  it("serializes presses made before the first restore finishes", async () => {
    for (const id of ["a", "b"]) seed(id);
    userClose(["a"]);
    userClose(["b"]);

    const results = await Promise.all([undoLastClose(), undoLastClose()]);

    expect(results).toEqual([true, true]);
    expect(locationOf("a")).toBe("grid");
    expect(locationOf("b")).toBe("grid");
    expect(usePanelStore.getState().focusedId).toBe("a");
  });

  it("records only closes a person asked for", () => {
    seed("a");
    seed("b");
    history.userCloseCommit("agent", ["a"], () => usePanelStore.getState().trashPanel("a"))();
    history.userCloseCommit("plugin", ["b"], () => usePanelStore.getState().trashPanel("b"))();
    expect(history.peekUndoCloseStep()).toBeNull();

    seed("c");
    history.userCloseCommit("keybinding", ["c"], () => usePanelStore.getState().trashPanel("c"))();
    expect(history.peekUndoCloseStep()?.panels.map((panel) => panel.id)).toEqual(["c"]);
  });

  it("records nothing before a panel store is connected", () => {
    history.connectPanelCloseHistory(null);
    seed("a");
    userClose(["a"]);
    expect(locationOf("a")).toBe("trash");
    history.connectPanelCloseHistory(usePanelStore);
    expect(history.peekUndoCloseStep()).toBeNull();
  });

  it("records nothing when the commit never trashed the panel", () => {
    seed("a");
    userClose(["a"], () => undefined);
    expect(history.peekUndoCloseStep()).toBeNull();
  });

  it("keeps the newest ten closes", () => {
    for (let i = 0; i < 12; i++) {
      seed(`p${i}`);
      userClose([`p${i}`]);
    }
    const seen: string[] = [];
    for (let step = history.takeUndoCloseStep(); step; step = history.takeUndoCloseStep()) {
      seen.push(step.panels[0]!.id);
    }
    expect(seen).toEqual(["p11", "p10", "p9", "p8", "p7", "p6", "p5", "p4", "p3", "p2"]);
  });

  it("drops a close restored another way, and the next press takes the older one", async () => {
    seed("a");
    seed("b");
    userClose(["a"]);
    userClose(["b"]);
    // Cmd+Shift+T, the trash pill or Canopy restore it.
    usePanelStore.getState().restoreTerminal("b");

    await expect(undoLastClose()).resolves.toBe(true);
    expect(locationOf("a")).toBe("grid");
    expect(history.peekUndoCloseStep()).toBeNull();
  });

  it("is unaffected by opening, moving or focusing panels in between", async () => {
    seed("a");
    seed("b");
    userClose(["a"]);
    seed("new");
    usePanelStore.getState().setFocused("new");
    usePanelStore.getState().moveTerminalToPosition("b", 0, "dock", "wt-1");

    await expect(undoLastClose()).resolves.toBe(true);
    expect(locationOf("a")).toBe("grid");
    expect(usePanelStore.getState().focusedId).toBe("a");
  });

  it("brings back a batch close as one step, its tab group whole", async () => {
    for (const id of ["a", "b", "c", "d"]) seed(id);
    usePanelStore.getState().createTabGroup("grid", "wt-1", ["a", "b", "c"], "b");
    // Close All: every panel trashed one by one, dissolving the group.
    userClose(["a", "b", "c", "d"]);
    expect(usePanelStore.getState().getPanelGroup("a")).toBeUndefined();

    await expect(undoLastClose()).resolves.toBe(true);

    for (const id of ["a", "b", "c", "d"]) expect(locationOf(id)).toBe("grid");
    const group = usePanelStore.getState().getPanelGroup("a");
    expect(group?.panelIds).toEqual(["a", "b", "c"]);
    expect(history.peekUndoCloseStep()).toBeNull();
  });

  it("brings back a closed tab group intact through the trash's group restore", async () => {
    for (const id of ["a", "b", "c"]) seed(id);
    usePanelStore.getState().createTabGroup("grid", "wt-1", ["a", "b", "c"], "c");
    usePanelStore.getState().setFocused("c");
    userClose(["a", "b", "c"], () => usePanelStore.getState().trashPanelGroup("a"));

    await expect(undoLastClose()).resolves.toBe(true);

    const group = usePanelStore.getState().getPanelGroup("a");
    expect(group?.panelIds).toEqual(["a", "b", "c"]);
    expect(group?.activeTabId).toBe("c");
    expect(usePanelStore.getState().focusedId).toBe("c");
  });

  it("puts a closed tab back in its group at its old place", async () => {
    for (const id of ["a", "b", "c"]) seed(id);
    const groupId = usePanelStore.getState().createTabGroup("grid", "wt-1", ["a", "b", "c"], "b");
    userClose(["b"]);
    expect(usePanelStore.getState().tabGroups.get(groupId)?.panelIds).toEqual(["a", "c"]);

    await expect(undoLastClose()).resolves.toBe(true);

    const group = usePanelStore.getState().tabGroups.get(groupId);
    expect(group?.panelIds).toEqual(["a", "b", "c"]);
    expect(group?.activeTabId).toBe("b");
  });

  it("rebuilds a two-tab group the close dissolved", async () => {
    for (const id of ["a", "b"]) seed(id);
    usePanelStore.getState().createTabGroup("grid", "wt-1", ["a", "b"], "a");
    userClose(["a"]);
    expect(usePanelStore.getState().getPanelGroup("b")).toBeUndefined();

    await expect(undoLastClose()).resolves.toBe(true);

    expect(usePanelStore.getState().getPanelGroup("a")?.panelIds).toEqual(["a", "b"]);
  });

  it("switches back to the worktree the panel was closed in", async () => {
    seed("a", { worktreeId: "wt-1" });
    userClose(["a"]);
    useWorktreeSelectionStore.setState({ activeWorktreeId: "wt-2" });

    await expect(undoLastClose()).resolves.toBe(true);

    expect(useWorktreeSelectionStore.getState().activeWorktreeId).toBe("wt-1");
    expect(usePanelStore.getState().focusedId).toBe("a");
  });

  it("only reopens closes from the project on screen", async () => {
    seed("a");
    userClose(["a"]);
    setProject("proj-2");

    expect(history.peekUndoCloseStep()).toBeNull();
    await expect(undoLastClose()).resolves.toBe(false);
    expect(locationOf("a")).toBe("trash");

    setProject("proj-1");
    await expect(undoLastClose()).resolves.toBe(true);
    expect(locationOf("a")).toBe("grid");
  });

  it("skips a shell the trash has let go and reopens the next older close", async () => {
    seed("older");
    seed("shell");
    userClose(["older"]);
    userClose(["shell"]);
    usePanelStore.getState().removePanel("shell");

    await expect(undoLastClose()).resolves.toBe(true);
    expect(locationOf("older")).toBe("grid");
    expect(resumeSessionForPerson).not.toHaveBeenCalled();
  });
});

describe("after the trash lets an agent go", () => {
  function record(overrides: Partial<AgentSessionRecord>): AgentSessionRecord {
    return {
      sessionId: "s",
      agentId: "claude",
      worktreeId: "wt-1",
      title: null,
      projectId: "proj-1",
      savedAt: Date.now() + 1_000,
      ...overrides,
    };
  }

  it("resumes that agent's own conversation in its old place, never the newest one", async () => {
    seed("agent", { agent: true });
    seed("after");
    userClose(["agent"]);
    usePanelStore.getState().removePanel("agent");
    const own = record({ sessionId: "own", terminal: { id: "agent", spawnedAt: 1 } });
    const newer = record({ sessionId: "newer", savedAt: Date.now() + 5_000 });
    listSessions.mockResolvedValue([newer, own]);
    resumeSessionForPerson.mockImplementation(async () => {
      seed("resumed");
      return { terminalId: "resumed", outcome: "created", worktreeId: "wt-1" };
    });

    await expect(undoLastClose()).resolves.toBe(true);

    expect(resumeSessionForPerson).toHaveBeenCalledTimes(1);
    expect(resumeSessionForPerson.mock.calls[0]![0]).toBe(own);
    const { panelIds } = usePanelStore.getState();
    expect(panelIds.indexOf("resumed")).toBe(panelIds.indexOf("after") - 1);
    expect(useResumedSessionPanelStore.getState().panelIds.has("resumed")).toBe(true);
    expect(usePanelStore.getState().focusedId).toBe("resumed");
  });

  it("skips an agent whose conversation was never captured", async () => {
    seed("older");
    seed("agent", { agent: true });
    userClose(["older"]);
    userClose(["agent"]);
    usePanelStore.getState().removePanel("agent");
    // The capture window has passed: nothing is still on its way.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + CAPTURE_WAIT_MS + 1);

    await expect(undoLastClose()).resolves.toBe(true);

    expect(resumeSessionForPerson).not.toHaveBeenCalled();
    expect(locationOf("older")).toBe("grid");
  });

  it("waits for a capture still on its way", async () => {
    let recorded: (() => void) | undefined;
    Reflect.set(window, "electron", {
      agentSessionHistory: { list: listSessions },
      events: {
        on: vi.fn((_channel: string, callback: () => void) => {
          recorded = callback;
          return () => undefined;
        }),
      },
    });
    seed("agent", { agent: true });
    userClose(["agent"]);
    usePanelStore.getState().removePanel("agent");
    resumeSessionForPerson.mockImplementation(async () => {
      seed("resumed");
      return { terminalId: "resumed", outcome: "created", worktreeId: "wt-1" };
    });

    const pending = undoLastClose();
    await vi.waitFor(() => expect(recorded).toBeDefined());
    listSessions.mockResolvedValue([
      record({ sessionId: "own", terminal: { id: "agent", spawnedAt: 1 } }),
    ]);
    recorded!();

    await expect(pending).resolves.toBe(true);
    expect(resumeSessionForPerson.mock.calls[0]![0]).toMatchObject({ sessionId: "own" });
  });
});

describe("undoCloseTakesKey", () => {
  function typeInto(field: HTMLTextAreaElement, value: string) {
    field.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: value })
    );
    field.value = value;
  }

  it("leaves the key alone with nothing to reopen", () => {
    expect(undoCloseTakesKey(document.body, false)).toBe(false);
    expect(undoCloseTakesKey(document.body, true)).toBe(false);
  });

  it("takes it in a terminal and anywhere without text of its own", () => {
    seed("a");
    userClose(["a"]);
    expect(undoCloseTakesKey(document.body, true)).toBe(true);
    expect(undoCloseTakesKey(document.body, false)).toBe(true);
  });

  it("leaves a plugin's view its own key", () => {
    seed("a");
    userClose(["a"]);
    const view = document.createElement("div");
    view.setAttribute(PLUGIN_STYLE_OWNER_ATTRIBUTE, "plugin-1");
    const inner = document.createElement("button");
    view.appendChild(inner);
    expect(undoCloseTakesKey(inner, false)).toBe(false);
  });

  it("lets a field undo typing newer than the close first, then reopens", () => {
    trackNativeFieldEdits();
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    typeInto(field, "older draft");
    seed("a");
    userClose(["a"]);
    // Cmd+W landed in a field holding an older draft: the close comes first.
    expect(undoCloseTakesKey(field, false)).toBe(true);

    typeInto(field, "older draft, newer words");
    expect(undoCloseTakesKey(field, false)).toBe(false);

    field.value = "older draft";
    expect(undoCloseTakesKey(field, false)).toBe(true);
    field.remove();
  });
});
