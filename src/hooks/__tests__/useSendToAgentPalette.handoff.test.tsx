// @vitest-environment jsdom
import { renderHook, act, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

const { useWorktreeStoreOptionalMock, writeMock, notifyUserInputMock } = vi.hoisted(() => ({
  useWorktreeStoreOptionalMock: vi.fn(),
  writeMock: vi.fn(),
  notifyUserInputMock: vi.fn(),
}));

// The real module drags WorktreeStoreContext's whole renderer graph in; these
// tests only need the (empty) worktree map the selector reads.
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: useWorktreeStoreOptionalMock,
}));

vi.mock("@/services/TerminalInstanceService", () => {
  const terminalInstanceService = {
    getCachedSelection: () => "",
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
  terminalClient: { write: writeMock, submit: vi.fn() },
}));

import { usePanelStore } from "@/store/panelStore";
import { usePaletteStore } from "@/store/paletteStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useTypingLocatorStore } from "@/store/typingLocatorStore";
import { consumePaletteFocusRestoreSuppression } from "@/components/ui/paletteFocusRestore";
import { useSendToAgentPalette, openSendToAgentPaletteWithText } from "../useSendToAgentPalette";
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

function openWith(panels: PtyPanelData[]) {
  usePanelStore.setState({
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])),
    panelIds: panels.map((p) => p.id),
  });
  expect(openSendToAgentPaletteWithText(COMPLETION, "source")).toBe(true);
  usePaletteStore.setState({ activePaletteId: "send-to-agent" });
  const { result } = renderHook(() => useSendToAgentPalette());
  const row = (id: string) => {
    const item = result.current.results.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`no row for ${id}`);
    return item;
  };
  return { result, row };
}

function draftOf(id: string): string {
  return useTerminalInputStore.getState().getDraftInput(id, undefined);
}

beforeEach(() => {
  useWorktreeStoreOptionalMock.mockImplementation(
    (_selector: unknown, fallback: unknown) => fallback
  );
  writeMock.mockReset();
  notifyUserInputMock.mockReset();
  useTerminalInputStore.setState({ hybridInputEnabled: true });
  useTerminalInputStore.getState().clearDraftInput("b", undefined);
  useTypingLocatorStore.setState({ message: null, revision: 0 });
  consumePaletteFocusRestoreSuppression();
});

afterEach(() => {
  cleanup();
  usePaletteStore.setState({ activePaletteId: null });
  usePanelStore.setState({ panelsById: {}, panelIds: [], focusedId: null });
});

describe("send to agent, an agent target", () => {
  it("drafts a headed block into its composer and writes nothing to its terminal", () => {
    const { result, row } = openWith([agent("source"), agent("b")]);
    expect(row("b").delivery).toBe("draft");

    act(() => {
      result.current.selectItem(row("b"));
    });

    expect(writeMock).not.toHaveBeenCalled();
    expect(notifyUserInputMock).not.toHaveBeenCalled();
    expect(draftOf("b")).toBe(
      "```daintree-context\nCodex: Terminal output\n\nTests failed: 2\n```\n"
    );
    expect(useTypingLocatorStore.getState().message?.kind).toBe("draft-added");
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
  });

  it("takes the user to the pane, keeping the palette from handing focus back", () => {
    const { result, row } = openWith([agent("source"), agent("b")]);

    act(() => {
      result.current.selectItem(row("b"));
    });

    expect(usePanelStore.getState().focusedId).toBe("b");
    expect(consumePaletteFocusRestoreSuppression()).toBe(true);
  });

  it("stays open with the text on a refusal, so it can still go elsewhere", () => {
    const { result, row } = openWith([agent("source"), agent("b"), shell("c")]);
    act(() => {
      useTerminalInputStore.setState({ hybridInputEnabled: false });
    });

    act(() => {
      result.current.selectItem(row("b"));
    });

    expect(draftOf("b")).toBe("");
    expect(useTypingLocatorStore.getState().message?.kind).toBe("draft-refused");
    expect(usePaletteStore.getState().activePaletteId).toBe("send-to-agent");
    // A refusal moves no focus, so the palette must still hand it back.
    expect(consumePaletteFocusRestoreSuppression()).toBe(false);

    act(() => {
      result.current.selectItem(row("c"));
    });
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0]![0]).toBe("c");
    expect(writeMock.mock.calls[0]![1]).toContain("Tests failed: 2");
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

    expect(writeMock).not.toHaveBeenCalled();
    expect(draftOf("b")).toBe("");
    // Skipped, not refused: the row was offering something it can no longer do.
    expect(useTypingLocatorStore.getState().message).toBeNull();
    expect(usePaletteStore.getState().activePaletteId).toBe("send-to-agent");
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

    expect(writeMock).not.toHaveBeenCalled();
    expect(draftOf("b")).toBe("");
    expect(usePaletteStore.getState().activePaletteId).toBe("send-to-agent");
    expect(row("b").delivery).toBe("draft");
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
    // The heading is for a draft; the shell gets the text alone.
    expect(writeMock.mock.calls[0]![1]).not.toContain("Terminal output");
    expect(notifyUserInputMock).toHaveBeenCalledWith("c");
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
    expect(consumePaletteFocusRestoreSuppression()).toBe(false);
  });
});
