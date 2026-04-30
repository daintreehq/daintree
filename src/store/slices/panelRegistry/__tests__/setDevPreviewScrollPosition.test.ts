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
  },
}));

const saveMock = vi.fn();

vi.mock("../../../persistence/panelPersistence", () => ({
  panelPersistence: {
    setProjectIdGetter: vi.fn(),
    save: saveMock,
    saveTabGroups: vi.fn(),
    load: vi.fn().mockReturnValue([]),
  },
}));

const { usePanelStore } = await import("../../../panelStore");

describe("setDevPreviewScrollPosition", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      electron: {},
    });

    const { reset } = usePanelStore.getState();
    await reset();
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("stores the scroll position on a dev-preview panel and triggers persistence", () => {
    usePanelStore.setState({
      panelsById: {
        "dev-1": {
          id: "dev-1",
          kind: "dev-preview",
          title: "Dev",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["dev-1"],
    });

    usePanelStore
      .getState()
      .setDevPreviewScrollPosition("dev-1", { url: "http://localhost:3000", scrollY: 420 });

    const stored = usePanelStore.getState().panelsById["dev-1"];
    expect(stored?.kind).toBe("dev-preview");
    expect(stored?.devPreviewScrollPosition).toEqual({
      url: "http://localhost:3000",
      scrollY: 420,
    });
    expect(saveMock).toHaveBeenCalled();
  });

  it("clears the scroll position when called with undefined", () => {
    usePanelStore.setState({
      panelsById: {
        "dev-1": {
          id: "dev-1",
          kind: "dev-preview",
          title: "Dev",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
          devPreviewScrollPosition: { url: "http://localhost:3000", scrollY: 100 },
        },
      },
      panelIds: ["dev-1"],
    });

    usePanelStore.getState().setDevPreviewScrollPosition("dev-1", undefined);

    const stored = usePanelStore.getState().panelsById["dev-1"];
    expect(stored?.devPreviewScrollPosition).toBeUndefined();
  });

  it("is a no-op for non-dev-preview kinds", () => {
    usePanelStore.setState({
      panelsById: {
        "browser-1": {
          id: "browser-1",
          kind: "browser",
          title: "Browser",
          location: "grid",
        },
      },
      panelIds: ["browser-1"],
    });

    usePanelStore
      .getState()
      .setDevPreviewScrollPosition("browser-1", { url: "https://example.com", scrollY: 200 });

    const stored = usePanelStore.getState().panelsById["browser-1"] as
      | Record<string, unknown>
      | undefined;
    expect(stored?.devPreviewScrollPosition).toBeUndefined();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("skips persistence when clearing an already-cleared position", () => {
    usePanelStore.setState({
      panelsById: {
        "dev-1": {
          id: "dev-1",
          kind: "dev-preview",
          title: "Dev",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
        },
      },
      panelIds: ["dev-1"],
    });

    usePanelStore.getState().setDevPreviewScrollPosition("dev-1", undefined);

    expect(saveMock).not.toHaveBeenCalled();
  });

  it("skips persistence when value is identical", () => {
    usePanelStore.setState({
      panelsById: {
        "dev-1": {
          id: "dev-1",
          kind: "dev-preview",
          title: "Dev",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
          devPreviewScrollPosition: { url: "http://localhost:3000", scrollY: 420 },
        },
      },
      panelIds: ["dev-1"],
    });

    usePanelStore
      .getState()
      .setDevPreviewScrollPosition("dev-1", { url: "http://localhost:3000", scrollY: 420 });

    expect(saveMock).not.toHaveBeenCalled();
  });
});
