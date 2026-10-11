import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockNotify, mockGetProjectState, mockGetScratchState, panelsById, controllers } =
  vi.hoisted(() => ({
    mockNotify: vi.fn().mockReturnValue(""),
    mockGetProjectState: vi.fn(),
    mockGetScratchState: vi.fn(),
    panelsById: {} as Record<string, unknown>,
    controllers: new Map<
      number,
      {
        launchWhenReady: ReturnType<typeof vi.fn>;
        getSnapshot: () => { phase: string };
        subscribe: (listener: () => void) => () => void;
        phase: string;
        listeners: Set<() => void>;
      }
    >(),
  }));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(), getContext: vi.fn(() => ({})) },
}));
vi.mock("@/lib/notify", () => ({ notify: (...args: unknown[]) => mockNotify(...args) }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => mockGetProjectState() },
}));
vi.mock("@/store/scratchStore", () => ({
  useScratchStore: { getState: () => mockGetScratchState() },
}));
vi.mock("@/store/panelStore", () => ({
  usePanelStore: { getState: () => ({ panelsById, removePanel: vi.fn() }) },
}));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/sidebarToggle", () => ({ suppressSidebarResizes: vi.fn() }));
vi.mock("@/controllers/helpSessionControllerRegistry", () => ({
  acquireHelpSessionController: (slot: number) => {
    let controller = controllers.get(slot);
    if (!controller) {
      const listeners = new Set<() => void>();
      const created = {
        launchWhenReady: vi.fn(),
        phase: "idle",
        listeners,
        getSnapshot: () => ({ phase: created.phase }),
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      controller = created;
      controllers.set(slot, controller);
    }
    return controller;
  },
}));

import { registerHelpActions } from "../helpActions";
import {
  markHelpPanelRuntimeMounted,
  resetHelpPanelRuntimeGateForTests,
} from "@/lib/helpPanelRuntimeGate";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePaletteStore } from "@/store/paletteStore";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const PROJECT = { id: "proj-1", path: "/repo" };

function extractAction(): AnyActionDefinition {
  const registry: ActionRegistry = new Map();
  // Only `onOpenShortcuts` is reachable from the help actions.
  const callbacks = { onOpenShortcuts: vi.fn() } as unknown as ActionCallbacks;
  registerHelpActions(registry, callbacks);
  const factory = registry.get("help.resumePastSession");
  if (!factory) throw new Error("help.resumePastSession not registered");
  return factory();
}

function bindLane(slot: number, terminalId: string, agentId: string, agentSessionId?: string) {
  const store = useHelpPanelStore.getState();
  store.ensureSlot(slot);
  useHelpPanelStore.getState().setTerminal(slot, terminalId, agentId, `bearer-${slot}`);
  panelsById[terminalId] = { id: terminalId, kind: "terminal", agentSessionId };
}

describe("help.resumePastSession", () => {
  let action: AnyActionDefinition;
  const run = async (args?: unknown): Promise<unknown> => action.run(args, {});

  beforeEach(() => {
    vi.clearAllMocks();
    controllers.clear();
    for (const key of Object.keys(panelsById)) delete panelsById[key];
    mockGetProjectState.mockReturnValue({ currentProject: PROJECT, isBootstrapped: true });
    mockGetScratchState.mockReturnValue({ currentScratch: null });
    resetHelpPanelRuntimeGateForTests();
    markHelpPanelRuntimeMounted();
    useHelpPanelStore.setState(useHelpPanelStore.getInitialState(), true);
    usePaletteStore.setState({ activePaletteId: null });
    action = extractAction();
  });

  // Lane claims are module state held until the launch aimed at the lane
  // settles. Settle every launch so no claim outlives its test.
  afterEach(() => {
    for (const controller of controllers.values()) {
      for (const phase of ["provisioning", "idle"]) {
        controller.phase = phase;
        controller.listeners.forEach((listener) => listener());
      }
    }
  });

  it("stays out of the MCP surface", () => {
    expect(action.mcpVisibility).toBe("hidden");
  });

  it("opens the picker and the panel when called without a session", async () => {
    await run();
    expect(usePaletteStore.getState().activePaletteId).toBe("assistant-sessions");
    expect(useHelpPanelStore.getState().isOpen).toBe(true);
    expect(controllers.size).toBe(0);
  });

  it("focuses the tab already showing the conversation instead of resuming it again", async () => {
    bindLane(0, "term-0", "claude");
    bindLane(1, "term-1", "claude", "ABC-1");
    useHelpPanelStore.getState().setActiveSlot(0);

    const result = await run({ agentId: "claude", sessionId: "abc-1" });

    expect(result).toEqual({ outcome: "focused" });
    expect(useHelpPanelStore.getState().activeSlot).toBe(1);
    expect(controllers.size).toBe(0);
  });

  it("resumes into the free active tab by exact id", async () => {
    const result = await run({ agentId: "claude", sessionId: "abc-1" });

    expect(result).toEqual({ outcome: "resumed" });
    expect(controllers.get(0)?.launchWhenReady).toHaveBeenCalledWith({
      agentId: "claude",
      replaceExisting: true,
      resumeTarget: { sessionId: "abc-1" },
    });
    expect(useHelpPanelStore.getState().isOpen).toBe(true);
  });

  it("opens a new tab when the open ones are busy, and claims it until the launch settles", async () => {
    bindLane(0, "term-0", "claude");

    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({ outcome: "resumed" });
    expect(useHelpPanelStore.getState().sessions[1]).toBeDefined();
    expect(useHelpPanelStore.getState().activeSlot).toBe(1);
    const controller = controllers.get(1)!;
    expect(controller.launchWhenReady).toHaveBeenCalledTimes(1);

    // While the launch is in flight the lane stays claimed: a second pick
    // goes elsewhere rather than displacing it.
    controller.phase = "provisioning";
    controller.listeners.forEach((listener) => listener());
    await run({ agentId: "claude", sessionId: "def-2" });
    expect(controllers.get(2)?.launchWhenReady).toHaveBeenCalledTimes(1);
    expect(controller.launchWhenReady).toHaveBeenCalledTimes(1);
  });

  it("reports every tab busy instead of displacing one, then replaces the tab the user names", async () => {
    bindLane(0, "term-0", "claude");
    bindLane(1, "term-1", "claude");
    bindLane(2, "term-2", "claude");

    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({
      outcome: "lanes-full",
    });
    expect(controllers.size).toBe(0);

    expect(await run({ agentId: "claude", sessionId: "abc-1", slot: 1 })).toEqual({
      outcome: "resumed",
    });
    expect(controllers.get(1)?.launchWhenReady).toHaveBeenCalledWith(
      expect.objectContaining({ replaceExisting: true, resumeTarget: { sessionId: "abc-1" } })
    );
    expect(useHelpPanelStore.getState().activeSlot).toBe(1);
  });

  it("refuses a named tab another resume is already heading for", async () => {
    bindLane(0, "term-0", "claude");
    bindLane(1, "term-1", "claude");
    bindLane(2, "term-2", "claude");
    await run({ agentId: "claude", sessionId: "abc-1", slot: 1 });
    controllers.get(1)!.phase = "provisioning";
    controllers.get(1)!.listeners.forEach((listener) => listener());

    expect(await run({ agentId: "claude", sessionId: "def-2", slot: 1 })).toEqual({
      outcome: "lanes-full",
    });
    expect(controllers.get(1)!.launchWhenReady).toHaveBeenCalledTimes(1);
  });

  it("says a tab is busy rather than dropping the pick when it is mid-launch", async () => {
    const { acquireHelpSessionController } =
      await import("@/controllers/helpSessionControllerRegistry");
    acquireHelpSessionController(0);
    controllers.get(0)!.phase = "provisioning";

    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({
      outcome: "unavailable",
    });
    expect(controllers.get(0)!.launchWhenReady).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));

    // The refused pick left no claim behind.
    controllers.get(0)!.phase = "idle";
    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({ outcome: "resumed" });
  });

  it("ignores a closed tab's capture when checking the agent", async () => {
    useHelpPanelStore.getState().setHibernateSession(PROJECT.id, 2, {
      sessionId: "old",
      cwd: "/help",
      agentId: "claude",
    });
    expect(await run({ agentId: "codex", sessionId: "thread-1" })).toEqual({
      outcome: "resumed",
    });
  });

  it("refuses a named tab that has since closed", async () => {
    expect(await run({ agentId: "claude", sessionId: "abc-1", slot: 2 })).toEqual({
      outcome: "lanes-full",
    });
    expect(controllers.size).toBe(0);
  });

  it("resumes a conversation captured for a closed tab back into that tab", async () => {
    useHelpPanelStore.getState().setHibernateSession(PROJECT.id, 2, {
      sessionId: "abc-1",
      cwd: "/help",
      agentId: "claude",
    });

    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({ outcome: "resumed" });
    expect(useHelpPanelStore.getState().sessions[2]).toBeDefined();
    expect(controllers.get(2)?.launchWhenReady).toHaveBeenCalled();
  });

  it("explains instead of launching when another tab runs a different agent", async () => {
    bindLane(0, "term-0", "claude");

    expect(await run({ agentId: "codex", sessionId: "thread-1" })).toEqual({
      outcome: "agent-mismatch",
    });
    expect(controllers.size).toBe(0);
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ type: "warning" }));
  });

  it("allows a different agent when the tab running the other one is the one replaced", async () => {
    bindLane(0, "term-0", "claude");

    expect(await run({ agentId: "codex", sessionId: "thread-1", slot: 0 })).toEqual({
      outcome: "resumed",
    });
  });

  it("does nothing without a workspace", async () => {
    mockGetProjectState.mockReturnValue({ currentProject: null, isBootstrapped: true });

    expect(await run({ agentId: "claude", sessionId: "abc-1" })).toEqual({
      outcome: "unavailable",
    });
    expect(controllers.size).toBe(0);
  });

  it("keys captured entries by workspace, so another project's capture is not this tab's", async () => {
    useHelpPanelStore.getState().setHibernateSession("other-project", 2, {
      sessionId: "abc-1",
      cwd: "/help",
      agentId: "claude",
    });

    await run({ agentId: "claude", sessionId: "abc-1" });
    expect(controllers.get(0)?.launchWhenReady).toHaveBeenCalled();
    expect(controllers.get(2)).toBeUndefined();
  });
});
