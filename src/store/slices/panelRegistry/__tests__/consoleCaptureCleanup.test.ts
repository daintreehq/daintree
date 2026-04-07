/**
 * Issue #3275: removePanel must clean up consoleCaptureStore entries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
  appClient: {
    setState: vi.fn().mockResolvedValue(undefined),
  },
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
  },
  agentSettingsClient: {
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    cleanup: vi.fn(),
    applyRendererPolicy: vi.fn(),
    destroy: vi.fn(),
    setInputLocked: vi.fn(),
  },
}));

vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: vi.fn(),
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("../../../panelStore");
const { useConsoleCaptureStore } = await import("../../../consoleCaptureStore");
const { initStoreOrchestrator, destroyStoreOrchestrator } =
  await import("../../../rendererStoreOrchestrator");

describe("removePanel consoleCaptureStore cleanup", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    initStoreOrchestrator();
    await usePanelStore.getState().reset();
    usePanelStore.setState({
      panelsById: {},
      panelIds: [],
      tabGroups: new Map(),
      trashedTerminals: new Map(),
      backgroundedTerminals: new Map(),
      focusedId: null,
      maximizedId: null,
      commandQueue: [],
    });
    useConsoleCaptureStore.setState({ messages: new Map() });
  });

  afterEach(() => {
    destroyStoreOrchestrator();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("cleans up console messages when a browser panel is removed", () => {
    const panelId = "browser-1";

    usePanelStore.setState({
      panelsById: {
        [panelId]: {
          id: panelId,
          type: "terminal",
          kind: "browser",
          title: "Browser",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: [panelId],
    });

    useConsoleCaptureStore.getState().addStructuredMessage({
      id: 1,
      paneId: panelId,
      level: "log",
      cdpType: "log",
      args: [{ type: "primitive", kind: "string", value: "test" }],
      summaryText: "test",
      groupDepth: 0,
      timestamp: Date.now(),
      navigationGeneration: 0,
    });

    expect(useConsoleCaptureStore.getState().messages.has(panelId)).toBe(true);

    usePanelStore.getState().removePanel(panelId);

    expect(useConsoleCaptureStore.getState().messages.has(panelId)).toBe(false);
  });

  it("is safe to call removePane again after removePanel (idempotency)", () => {
    const panelId = "browser-2";

    usePanelStore.setState({
      panelsById: {
        [panelId]: {
          id: panelId,
          type: "terminal",
          kind: "browser",
          title: "Browser",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: [panelId],
    });

    useConsoleCaptureStore.getState().addStructuredMessage({
      id: 1,
      paneId: panelId,
      level: "error",
      cdpType: "log",
      args: [{ type: "primitive", kind: "string", value: "error msg" }],
      summaryText: "error msg",
      groupDepth: 0,
      timestamp: Date.now(),
      navigationGeneration: 0,
    });

    usePanelStore.getState().removePanel(panelId);

    // Simulate BrowserPane useEffect cleanup firing after removePanel
    expect(() => {
      useConsoleCaptureStore.getState().removePane(panelId);
    }).not.toThrow();

    expect(useConsoleCaptureStore.getState().messages.has(panelId)).toBe(false);
  });

  it("preserves other panes' messages when one browser panel is removed", () => {
    usePanelStore.setState({
      panelsById: {
        "browser-a": {
          id: "browser-a",
          type: "terminal",
          kind: "browser",
          title: "Browser A",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
        "browser-b": {
          id: "browser-b",
          type: "terminal",
          kind: "browser",
          title: "Browser B",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["browser-a", "browser-b"],
    });

    const addMsg = useConsoleCaptureStore.getState().addStructuredMessage;
    addMsg({
      id: 1,
      paneId: "browser-a",
      level: "log",
      cdpType: "log",
      args: [{ type: "primitive", kind: "string", value: "a" }],
      summaryText: "a",
      groupDepth: 0,
      timestamp: Date.now(),
      navigationGeneration: 0,
    });
    addMsg({
      id: 2,
      paneId: "browser-b",
      level: "log",
      cdpType: "log",
      args: [{ type: "primitive", kind: "string", value: "b" }],
      summaryText: "b",
      groupDepth: 0,
      timestamp: Date.now(),
      navigationGeneration: 0,
    });

    usePanelStore.getState().removePanel("browser-a");

    const state = useConsoleCaptureStore.getState();
    expect(state.messages.has("browser-a")).toBe(false);
    expect(state.messages.has("browser-b")).toBe(true);
    expect(state.messages.get("browser-b")).toHaveLength(1);
  });

  it("does not throw when removing a non-browser panel with no console messages", () => {
    const panelId = "terminal-1";

    usePanelStore.setState({
      panelsById: {
        [panelId]: {
          id: panelId,
          type: "terminal",
          title: "Shell",
          cwd: "/test",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: [panelId],
    });

    expect(() => {
      usePanelStore.getState().removePanel(panelId);
    }).not.toThrow();
  });
});
