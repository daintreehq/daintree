// @vitest-environment jsdom
import { renderHook, act, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import type { PtyPanelData, TabGroup } from "@shared/types/panel";
import { AGENT_CONTEXT_MAX_TEXT_LENGTH } from "@shared/utils/agentContextDrag";

const {
  useWorktreeStoreOptionalMock,
  writeMock,
  submitMock,
  notifyUserInputMock,
  requestPaneFocusMock,
  cachedSelection,
} = vi.hoisted(() => ({
  useWorktreeStoreOptionalMock: vi.fn(),
  writeMock: vi.fn(),
  submitMock: vi.fn(),
  notifyUserInputMock: vi.fn(),
  requestPaneFocusMock: vi.fn<(paneId: string, surface: string) => boolean>(),
  cachedSelection: { text: "" },
}));

// The real module drags WorktreeStoreContext's whole renderer graph in; these
// tests only need the (empty) worktree map the selector reads.
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: useWorktreeStoreOptionalMock,
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    getCachedSelection: () => cachedSelection.text,
    get: () => ({ terminal: { modes: { bracketedPasteMode: true } } }),
    notifyUserInput: notifyUserInputMock,
    // Activating the target wakes its renderer.
    wake: vi.fn(),
    wakeForFocus: vi.fn(),
  };
  return {
    createTerminalPaintPlane: () => terminalInstanceService,
  };
});

// Partial: the panel store's persistence layer reads `projectClient` from this
// same barrel at module eval, so a bare object mock breaks the import graph.
vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  terminalClient: { write: writeMock, submit: submitMock },
}));

// No editor is mounted here, so the surface asked for is the observable part.
vi.mock("@/components/Terminal/paneFocusRequest", () => ({
  requestPaneFocus: requestPaneFocusMock,
}));

import { usePanelStore } from "@/store/panelStore";
import { usePaletteStore } from "@/store/paletteStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useTypingLocatorStore } from "@/store/typingLocatorStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { consumePaletteFocusRestoreSuppression } from "@/components/ui/paletteFocusRestore";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import {
  useSendToAgentPalette,
  openSendToAgentPalette,
  openSendToAgentPaletteWithText,
} from "../useSendToAgentPalette";
import { load as loadTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";

beforeAll(async () => {
  await loadTerminalService();
});

function agent(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
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

function shell(id: string): PtyPanelData {
  return agent(id, { title: "zsh", launchAgentId: undefined });
}

const COMPLETION = { text: "Tests failed: 2", title: "Terminal output", sourceLabel: "Codex" };

function seed(panels: PtyPanelData[]): void {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
}

function renderPalette() {
  const { result } = renderHook(() => useSendToAgentPalette());
  const row = (id: string) => {
    const item = result.current.results.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`no row for ${id}`);
    return item;
  };
  return { result, row };
}

function openWith(panels: PtyPanelData[], content = COMPLETION) {
  seed(panels);
  expect(openSendToAgentPaletteWithText(content, "source")).toBe(true);
  return renderPalette();
}

function draftOf(id: string): string {
  return useTerminalInputStore.getState().getDraftInput(id, undefined);
}

function expectNothingDelivered(id: string): void {
  expect(writeMock).not.toHaveBeenCalled();
  expect(submitMock).not.toHaveBeenCalled();
  expect(draftOf(id)).toBe("");
  expect(requestPaneFocusMock).not.toHaveBeenCalled();
  expect(usePaletteStore.getState().activePaletteId).toBe("send-to-agent");
  // Nothing moved focus, so the palette must still hand it back.
  expect(consumePaletteFocusRestoreSuppression()).toBe(false);
}

beforeEach(() => {
  useWorktreeStoreOptionalMock.mockImplementation(
    (_selector: unknown, fallback: unknown) => fallback
  );
  writeMock.mockReset();
  submitMock.mockReset();
  notifyUserInputMock.mockReset();
  requestPaneFocusMock.mockReset();
  cachedSelection.text = "";
  useTerminalInputStore.setState({ hybridInputEnabled: true });
  useTypingLocatorStore.setState({ message: null, revision: 0 });
  consumePaletteFocusRestoreSuppression();
});

afterEach(() => {
  cleanup();
  for (const id of ["b", "c"]) useTerminalInputStore.getState().clearDraftInput(id, undefined);
  usePaletteStore.setState({ activePaletteId: null });
  usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null, tabGroups: new Map() });
  consumePaletteFocusRestoreSuppression();
});

describe("send to agent, an agent target", () => {
  it("drafts a headed block into its composer and writes nothing to its terminal", () => {
    const { result, row } = openWith([agent("source"), agent("b")]);
    expect(row("b").delivery).toBe("draft");

    act(() => {
      result.current.selectItem(row("b"));
    });

    expect(writeMock).not.toHaveBeenCalled();
    expect(submitMock).not.toHaveBeenCalled();
    expect(notifyUserInputMock).not.toHaveBeenCalled();
    expect(draftOf("b")).toBe(
      "```daintree-context\nCodex: Terminal output\n\nTests failed: 2\n```\n"
    );
    expect(useTypingLocatorStore.getState().message?.kind).toBe("draft-added");
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
  });

  it("takes the keyboard to the pane's composer, keeping the palette from handing it back", () => {
    const { result, row } = openWith([agent("source"), agent("b")]);

    act(() => {
      result.current.selectItem(row("b"));
    });

    expect(usePanelStore.getState().focusedId).toBe("b");
    expect(requestPaneFocusMock).toHaveBeenCalledWith("b", "hybridInput");
    expect(consumePaletteFocusRestoreSuppression()).toBe(true);
  });

  it("brings a background tab forward, since its group would keep showing the other", () => {
    const group: TabGroup = {
      id: "g",
      location: "grid",
      activeTabId: "x",
      panelIds: ["x", "b"],
    };
    const { result, row } = openWith([agent("source"), agent("x"), agent("b")]);
    act(() => {
      usePanelStore.setState({ tabGroups: new Map([["g", group]]) });
    });

    act(() => {
      result.current.selectItem(row("b"));
    });

    expect(usePanelStore.getState().tabGroups.get("g")?.activeTabId).toBe("b");
  });

  it("switches to the pane's worktree when it isn't the one on screen", () => {
    const selectWorktree = vi.fn();
    const trackTerminalFocus = vi.fn();
    const original = useWorktreeSelectionStore.getState();
    useWorktreeSelectionStore.setState({
      activeWorktreeId: "wt-main",
      selectWorktree,
      trackTerminalFocus,
    });
    try {
      const { result, row } = openWith([
        agent("source", { worktreeId: "wt-main" }),
        agent("b", { worktreeId: "wt-feat" }),
      ]);

      act(() => {
        result.current.selectItem(row("b"));
      });

      expect(trackTerminalFocus).toHaveBeenCalledWith("wt-feat", "b");
      expect(selectWorktree).toHaveBeenCalledWith("wt-feat");
    } finally {
      useWorktreeSelectionStore.setState({
        activeWorktreeId: original.activeWorktreeId,
        selectWorktree: original.selectWorktree,
        trackTerminalFocus: original.trackTerminalFocus,
      });
    }
  });

  it("stays open with the text on a refusal, so it can still go elsewhere", () => {
    const { result, row } = openWith([agent("source"), agent("b"), shell("c")]);
    act(() => {
      useTerminalInputStore.setState({ hybridInputEnabled: false });
    });

    act(() => {
      result.current.selectItem(row("b"));
    });

    expectNothingDelivered("b");
    expect(useTypingLocatorStore.getState().message?.kind).toBe("draft-refused");

    act(() => {
      result.current.selectItem(row("c"));
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0]![0]).toBe("c");
    expect(writeMock.mock.calls[0]![1]).toContain(COMPLETION.text);
  });

  it("refuses a docked agent rather than pasting behind it", () => {
    const { result, row } = openWith([agent("source"), agent("b", { location: "dock" })]);

    act(() => {
      result.current.selectItem(row("b"));
    });

    expectNothingDelivered("b");
    expect(useTypingLocatorStore.getState().message?.lead).toContain("grid");
  });

  it("refuses text longer than a draft holds instead of cutting it short", () => {
    const text = "x".repeat(AGENT_CONTEXT_MAX_TEXT_LENGTH + 1);
    const { result, row } = openWith([agent("source"), agent("b"), shell("c")], {
      ...COMPLETION,
      text,
    });

    act(() => {
      result.current.selectItem(row("b"));
    });

    expectNothingDelivered("b");
    expect(useTypingLocatorStore.getState().message?.kind).toBe("draft-refused");

    // A shell has no such bound, so the same text can still go there whole.
    act(() => {
      result.current.selectItem(row("c"));
    });
    expect(writeMock.mock.calls[0]![1]).toContain(text);
  });

  it("measures the text as the draft will hold it, so CRLF line endings don't count twice", () => {
    const text = "x\r\n".repeat(Math.floor(AGENT_CONTEXT_MAX_TEXT_LENGTH / 2));
    expect(text.length).toBeGreaterThan(AGENT_CONTEXT_MAX_TEXT_LENGTH);
    const { result, row } = openWith([agent("source"), agent("b")], { ...COMPLETION, text });

    act(() => {
      result.current.selectItem(row("b"));
    });

    expect(draftOf("b")).toContain("x\nx\n");
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
  });

  it("does not paste into an agent that quit back to its shell while the palette was open", () => {
    const { result, row } = openWith([agent("source"), agent("b")]);
    const offered = row("b");
    act(() => {
      usePanelStore.setState((s) => ({
        panelsById: { ...s.panelsById, b: shell("b") },
      }));
    });

    act(() => {
      result.current.selectItem(offered);
    });

    expectNothingDelivered("b");
    // Skipped, not refused: the row was offering something it can no longer do.
    expect(useTypingLocatorStore.getState().message).toBeNull();
    expect(row("b").delivery).toBe("paste");
  });

  it("does not paste behind the composer of a shell that started an agent while open", () => {
    const { result, row } = openWith([agent("source"), shell("b")]);
    const offered = row("b");
    act(() => {
      usePanelStore.setState((s) => ({
        panelsById: { ...s.panelsById, b: agent("b") },
      }));
    });

    act(() => {
      result.current.selectItem(offered);
    });

    expectNothingDelivered("b");
    expect(row("b").delivery).toBe("draft");
  });

  it("does not deliver to an agent trashed while the palette was open", () => {
    const { result, row } = openWith([agent("source"), agent("b")]);
    const offered = row("b");
    act(() => {
      usePanelStore.setState((s) => ({
        panelsById: { ...s.panelsById, b: agent("b", { location: "trash" }) },
      }));
    });

    act(() => {
      result.current.selectItem(offered);
    });

    expectNothingDelivered("b");
  });
});

describe("send to agent, a shell target", () => {
  it("still pastes into its input, since it has no draft", () => {
    const { result, row } = openWith([agent("source"), shell("c")]);
    expect(row("c").delivery).toBe("paste");

    act(() => {
      result.current.selectItem(row("c"));
    });

    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0]![0]).toBe("c");
    expect(writeMock.mock.calls[0]![1]).toContain(COMPLETION.text);
    // The heading is for a draft; the shell gets the text alone.
    expect(writeMock.mock.calls[0]![1]).not.toContain(COMPLETION.title);
    expect(draftOf("c")).toBe("");
    expect(notifyUserInputMock).toHaveBeenCalledWith("c");
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
    expect(consumePaletteFocusRestoreSuppression()).toBe(false);
  });
});

describe("send to agent, what the palette holds", () => {
  it("is spent by a delivery, so a second pick sends nothing", () => {
    const { result, row } = openWith([agent("source"), agent("b"), shell("c")]);
    const shellRow = row("c");
    act(() => {
      result.current.selectItem(row("b"));
    });
    act(() => {
      result.current.selectItem(shellRow);
    });

    expect(writeMock).not.toHaveBeenCalled();
  });

  it("heads a terminal selection with the pane it came from", () => {
    const source = agent("source", { title: "Codex", launchAgentId: "codex" });
    seed([source, agent("b")]);
    cachedSelection.text = "the selected lines";
    expect(openSendToAgentPalette("source")).toBe(true);
    const { result, row } = renderPalette();

    act(() => {
      result.current.selectItem(row("b"));
    });

    const heading = `${getTerminalDisplayTitle(source, "full")}: Selection`;
    expect(draftOf("b")).toContain(`${heading}\n\nthe selected lines`);
  });
});
