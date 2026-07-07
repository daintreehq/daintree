import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PanelInstance, MarkdownPanelData } from "@shared/types/panel";

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

function seedMarkdownPanel(overrides: Partial<MarkdownPanelData> = {}): void {
  usePanelStore.setState({
    panelsById: {
      "md-1": {
        id: "md-1",
        kind: "markdown",
        title: "Markdown",
        location: "grid",
        markdownFilePath: "/repo/docs/spec.md",
        markdownViewMode: "rendered",
        ...overrides,
      } as PanelInstance,
    },
    panelIds: ["md-1"],
  });
}

describe("markdown panel state setters", () => {
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

  it("setMarkdownViewMode updates the panel and triggers persistence", () => {
    seedMarkdownPanel();

    usePanelStore.getState().setMarkdownViewMode("md-1", "source");

    const stored = usePanelStore.getState().panelsById["md-1"] as MarkdownPanelData | undefined;
    expect(stored?.markdownViewMode).toBe("source");
    expect(saveMock).toHaveBeenCalled();
  });

  it("setMarkdownViewMode is a no-op when the mode is unchanged (default rendered)", () => {
    seedMarkdownPanel({ markdownViewMode: undefined });
    const before = usePanelStore.getState().panelsById["md-1"];

    usePanelStore.getState().setMarkdownViewMode("md-1", "rendered");

    expect(usePanelStore.getState().panelsById["md-1"]).toBe(before);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("setMarkdownFilePath swaps the file and triggers persistence", () => {
    seedMarkdownPanel();

    usePanelStore.getState().setMarkdownFilePath("md-1", "/repo/README.md");

    const stored = usePanelStore.getState().panelsById["md-1"] as MarkdownPanelData | undefined;
    expect(stored?.markdownFilePath).toBe("/repo/README.md");
    expect(saveMock).toHaveBeenCalled();
  });

  it("both setters refuse to touch non-markdown panels", () => {
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

    usePanelStore.getState().setMarkdownViewMode("term-1", "source");
    usePanelStore.getState().setMarkdownFilePath("term-1", "/repo/README.md");

    expect(usePanelStore.getState().panelsById["term-1"]).toBe(before);
    expect(saveMock).not.toHaveBeenCalled();
  });
});
