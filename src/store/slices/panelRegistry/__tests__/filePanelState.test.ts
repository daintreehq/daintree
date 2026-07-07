import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PanelInstance, FilePanelData } from "@shared/types/panel";

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
    onPanelBackgrounded: vi.fn(),
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

function seedFilePanel(overrides: Partial<FilePanelData> = {}): void {
  usePanelStore.setState({
    panelsById: {
      "file-1": {
        id: "file-1",
        kind: "file",
        title: "File",
        location: "grid",
        filePath: "/repo/docs/spec.md",
        fileViewMode: "source",
        ...overrides,
      } as PanelInstance,
    },
    panelIds: ["file-1"],
  });
}

describe("file panel state setters", () => {
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

  it("setFileViewMode updates the panel and triggers persistence", () => {
    seedFilePanel();

    usePanelStore.getState().setFileViewMode("file-1", "rendered");

    const stored = usePanelStore.getState().panelsById["file-1"] as FilePanelData | undefined;
    expect(stored?.fileViewMode).toBe("rendered");
    expect(saveMock).toHaveBeenCalled();
  });

  it("setFileViewMode is a no-op when the mode is unchanged (default source)", () => {
    seedFilePanel({ fileViewMode: undefined });
    const before = usePanelStore.getState().panelsById["file-1"];

    usePanelStore.getState().setFileViewMode("file-1", "source");

    expect(usePanelStore.getState().panelsById["file-1"]).toBe(before);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("setFilePanelPath swaps the file and triggers persistence", () => {
    seedFilePanel();

    usePanelStore.getState().setFilePanelPath("file-1", "/repo/README.md");

    const stored = usePanelStore.getState().panelsById["file-1"] as FilePanelData | undefined;
    expect(stored?.filePath).toBe("/repo/README.md");
    expect(saveMock).toHaveBeenCalled();
  });

  it("both setters refuse to touch non-file panels", () => {
    usePanelStore.setState({
      panelsById: {
        "term-1": {
          id: "term-1",
          kind: "terminal",
          title: "Terminal",
          cwd: "/repo",
          cols: 80,
          rows: 24,
          location: "grid",
        } as PanelInstance,
      },
      panelIds: ["term-1"],
    });
    const before = usePanelStore.getState().panelsById["term-1"];

    usePanelStore.getState().setFileViewMode("term-1", "rendered");
    usePanelStore.getState().setFilePanelPath("term-1", "/repo/README.md");

    expect(usePanelStore.getState().panelsById["term-1"]).toBe(before);
    expect(saveMock).not.toHaveBeenCalled();
  });
});
