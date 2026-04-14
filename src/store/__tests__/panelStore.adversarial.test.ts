// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/controllers", () => ({
  terminalRegistryController: {
    kill: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    destroy: vi.fn(),
    detachForProjectSwitch: vi.fn(),
    suppressResizesDuringProjectSwitch: vi.fn(),
  },
}));

vi.mock("@/services/terminal/panelDuplicationService", () => ({
  buildPanelSnapshotOptions: vi.fn((p: { id: string }) => ({ id: p.id })),
}));

vi.mock("@/store/terminalInputStore", () => ({
  useTerminalInputStore: {
    getState: () => ({ clearAllDraftInputs: vi.fn() }),
  },
}));

const baseWatched = () => new Set<string>();

import { usePanelStore } from "../panelStore";
import { terminalRegistryController } from "@/controllers";
import { terminalInstanceService } from "@/services/TerminalInstanceService";

function resetStore() {
  usePanelStore.setState((s) => ({
    ...s,
    panelsById: {},
    panelIds: [],
    trashedTerminals: new Map(),
    backgroundedTerminals: new Map(),
    tabGroups: new Map(),
    focusedId: null,
    maximizedId: null,
    maximizeTarget: null,
    preMaximizeLayout: null,
    activeDockTerminalId: null,
    pingedId: null,
    commandQueue: [],
    commandQueueCountById: {},
    mruList: [],
    watchedPanels: baseWatched(),
    backendStatus: "connected",
    lastCrashType: null,
    lastClosedConfig: null,
  }));
}

describe("panelStore adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("clearTerminalStoreForSwitch clears watchedPanels so watches do not leak across project switches", () => {
    usePanelStore.getState().watchPanel("panel-from-project-a");
    expect(usePanelStore.getState().watchedPanels.size).toBe(1);

    usePanelStore.getState().clearTerminalStoreForSwitch();

    expect(usePanelStore.getState().watchedPanels.size).toBe(0);
  });

  it("reset drains all panel state even when destroy and kill throw", async () => {
    vi.mocked(terminalInstanceService.destroy).mockImplementationOnce(() => {
      throw new Error("destroy failed");
    });
    vi.mocked(terminalRegistryController.kill).mockRejectedValueOnce(new Error("kill failed"));

    usePanelStore.setState({
      panelsById: {
        p1: {
          id: "p1",
          title: "p1",
          cwd: "/a",
          location: "grid",
          createdAt: 1,
          type: "terminal",
          kind: "terminal",
        } as unknown as never,
        p2: {
          id: "p2",
          title: "p2",
          cwd: "/b",
          location: "grid",
          createdAt: 2,
          type: "terminal",
          kind: "terminal",
        } as unknown as never,
      },
      panelIds: ["p1", "p2"],
      focusedId: "p1",
      maximizedId: "p1",
      commandQueue: [
        {
          id: "q1",
          terminalId: "p1",
          payload: "x",
          description: "x",
          queuedAt: 0,
          origin: "user",
        },
      ],
      commandQueueCountById: { p1: 1 },
      mruList: ["p1", "p2"],
      backendStatus: "disconnected",
      lastCrashType: "UNKNOWN_CRASH",
    });

    await usePanelStore.getState().reset();

    const s = usePanelStore.getState();
    expect(s.panelIds).toEqual([]);
    expect(s.panelsById).toEqual({});
    expect(s.focusedId).toBeNull();
    expect(s.maximizedId).toBeNull();
    expect(s.commandQueue).toEqual([]);
    expect(s.commandQueueCountById).toEqual({});
    expect(s.mruList).toEqual([]);
    expect(s.backendStatus).toBe("connected");
    expect(s.lastCrashType).toBeNull();

    expect(terminalInstanceService.destroy).toHaveBeenCalledTimes(2);
    expect(terminalRegistryController.kill).toHaveBeenCalledTimes(2);
  });

  it("clearTerminalStoreForSwitch clears command queues so no stale commands replay into new project", () => {
    usePanelStore.setState({
      commandQueue: [
        {
          id: "q1",
          terminalId: "p1",
          payload: "x",
          description: "x",
          queuedAt: 0,
          origin: "user",
        },
      ],
      commandQueueCountById: { p1: 1 },
    });

    usePanelStore.getState().clearTerminalStoreForSwitch();

    expect(usePanelStore.getState().commandQueue).toEqual([]);
    expect(usePanelStore.getState().commandQueueCountById).toEqual({});
  });

  it("watchPanel + unwatchPanel round-trip is idempotent and does not leak references", () => {
    const state = usePanelStore.getState();
    state.watchPanel("p1");
    state.watchPanel("p1");
    state.watchPanel("p2");
    expect(usePanelStore.getState().watchedPanels.size).toBe(2);

    state.unwatchPanel("p1");
    state.unwatchPanel("p1");
    expect(usePanelStore.getState().watchedPanels.has("p1")).toBe(false);
    expect(usePanelStore.getState().watchedPanels.has("p2")).toBe(true);

    state.unwatchPanel("nonexistent");
    expect(usePanelStore.getState().watchedPanels.size).toBe(1);
  });

  it("clearTerminalStoreForSwitch replaces watchedPanels with a new Set instance", () => {
    usePanelStore.getState().watchPanel("p1");
    usePanelStore.getState().watchPanel("p2");
    const pre = usePanelStore.getState().watchedPanels;

    usePanelStore.getState().clearTerminalStoreForSwitch();

    const post = usePanelStore.getState().watchedPanels;
    expect(post).not.toBe(pre);
    expect(post.size).toBe(0);
  });
});
