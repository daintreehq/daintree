import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";

vi.mock("@/clients", () => ({
  terminalClient: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    trash: vi.fn().mockResolvedValue(undefined),
    restore: vi.fn().mockResolvedValue(true),
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

function seedTerminal(overrides: Partial<PtyPanelData> = {}): void {
  usePanelStore.setState({
    panelsById: {
      "term-1": {
        id: "term-1",
        kind: "terminal",
        title: "Claude",
        cwd: "/repo",
        worktreeId: "/repo",
        location: "grid",
        ...overrides,
      } as PanelInstance,
      "file-1": {
        id: "file-1",
        kind: "file",
        title: "File",
        location: "grid",
        filePath: "/repo/a.md",
      } as PanelInstance,
    },
    panelIds: ["term-1", "file-1"],
  });
}

function scratchpadOf(id: string) {
  const panel = usePanelStore.getState().panelsById[id];
  return panel && isPtyPanel(panel) ? panel.scratchpad : undefined;
}

describe("terminal scratchpad (#12835)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      electron: {},
    });
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("opens an empty scratchpad and persists it", () => {
    seedTerminal();

    usePanelStore.getState().showScratchpad("term-1");

    expect(scratchpadOf("term-1")).toEqual({ content: "", collapsed: false });
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a panel that is not a terminal, or no longer exists", () => {
    seedTerminal();
    const before = usePanelStore.getState().panelsById;

    usePanelStore.getState().showScratchpad("file-1");
    usePanelStore.getState().showScratchpad("gone");
    usePanelStore.getState().setScratchpadContent("gone", "late write");

    expect(usePanelStore.getState().panelsById).toBe(before);
    expect(usePanelStore.getState().panelsById["gone"]).toBeUndefined();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("writes content only to an open scratchpad, and skips unchanged writes", () => {
    seedTerminal();
    usePanelStore.getState().setScratchpadContent("term-1", "ignored");
    expect(scratchpadOf("term-1")).toBeUndefined();

    usePanelStore.getState().showScratchpad("term-1");
    usePanelStore.getState().setScratchpadContent("term-1", "npm test");
    saveMock.mockClear();
    usePanelStore.getState().setScratchpadContent("term-1", "npm test");

    expect(scratchpadOf("term-1")?.content).toBe("npm test");
    expect(saveMock).not.toHaveBeenCalled();
  });

  it("collapses a scratchpad with notes and expands it back as it was", () => {
    seedTerminal({ scratchpad: { content: "check CI", collapsed: false, width: 340 } });

    usePanelStore.getState().collapseScratchpad("term-1");
    expect(scratchpadOf("term-1")).toEqual({ content: "check CI", collapsed: true, width: 340 });

    usePanelStore.getState().showScratchpad("term-1");
    expect(scratchpadOf("term-1")).toEqual({ content: "check CI", collapsed: false, width: 340 });
  });

  it("removes an empty or whitespace-only scratchpad on collapse", () => {
    seedTerminal({ scratchpad: { content: " \n ", collapsed: false, width: 340 } });

    usePanelStore.getState().collapseScratchpad("term-1");

    expect(scratchpadOf("term-1")).toBeUndefined();
    usePanelStore.getState().showScratchpad("term-1");
    expect(scratchpadOf("term-1")).toEqual({ content: "", collapsed: false });
  });

  it("clamps the width it stores", () => {
    seedTerminal({ scratchpad: { content: "", collapsed: false } });

    usePanelStore.getState().setScratchpadWidth("term-1", 10_000);
    const wide = scratchpadOf("term-1")?.width ?? 0;
    usePanelStore.getState().setScratchpadWidth("term-1", 1);
    const narrow = scratchpadOf("term-1")?.width ?? 0;

    expect(wide).toBeLessThan(10_000);
    expect(narrow).toBeGreaterThan(1);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("keeps the notes when the terminal moves to another worktree", () => {
    seedTerminal({ scratchpad: { content: "moving", collapsed: false } });

    usePanelStore.getState().moveTerminalToWorktree("term-1", "/repo-wt");

    const panel = usePanelStore.getState().panelsById["term-1"];
    expect(panel?.worktreeId).toBe("/repo-wt");
    expect(scratchpadOf("term-1")?.content).toBe("moving");
  });

  it("keeps the notes through trash and restore, and drops them with the panel", () => {
    seedTerminal({ scratchpad: { content: "keep me", collapsed: true } });

    usePanelStore.getState().trashPanel("term-1");
    expect(usePanelStore.getState().panelsById["term-1"]?.location).toBe("trash");
    expect(scratchpadOf("term-1")?.content).toBe("keep me");

    usePanelStore.getState().restoreTerminal("term-1");
    expect(usePanelStore.getState().panelsById["term-1"]?.location).not.toBe("trash");
    expect(scratchpadOf("term-1")).toEqual({ content: "keep me", collapsed: true });

    usePanelStore.getState().removePanel("term-1");
    expect(usePanelStore.getState().panelsById["term-1"]).toBeUndefined();
  });

  it("seeds notes onto a terminal that has none, and never over existing ones", () => {
    seedTerminal();

    usePanelStore.getState().seedScratchpad("term-1", { content: "carried", collapsed: true });
    expect(scratchpadOf("term-1")).toEqual({ content: "carried", collapsed: true });

    usePanelStore.getState().seedScratchpad("term-1", { content: "other", collapsed: false });
    expect(scratchpadOf("term-1")?.content).toBe("carried");
  });

  it("does not seed a collapsed scratchpad with nothing in it", () => {
    seedTerminal();

    usePanelStore.getState().seedScratchpad("term-1", { content: " ", collapsed: true });

    expect(scratchpadOf("term-1")).toBeUndefined();
  });
});
