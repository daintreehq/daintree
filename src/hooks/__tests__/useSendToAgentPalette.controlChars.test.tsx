// @vitest-environment jsdom
import { renderHook, act, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";

const { useWorktreeStoreOptionalMock, managed, writeMock, notifyUserInputMock } = vi.hoisted(
  () => ({
    useWorktreeStoreOptionalMock: vi.fn(),
    managed: {
      value: undefined as { terminal: { modes: { bracketedPasteMode: boolean } } } | undefined,
    },
    writeMock: vi.fn(),
    notifyUserInputMock: vi.fn(),
  })
);

// The real module drags WorktreeStoreContext's whole renderer graph in; these
// tests only need the (empty) worktree map the selector reads.
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreOptional: useWorktreeStoreOptionalMock,
}));

vi.mock("@/services/TerminalInstanceService", () => ({
  terminalInstanceService: {
    getCachedSelection: () => "",
    get: () => managed.value,
    notifyUserInput: notifyUserInputMock,
  },
}));

// Partial: the panel store's persistence layer reads `projectClient` from this
// same barrel at module eval, so a bare object mock breaks the import graph.
vi.mock("@/clients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/clients")>()),
  terminalClient: { write: writeMock },
}));

import { usePanelStore } from "@/store/panelStore";
import { usePaletteStore } from "@/store/paletteStore";
import { useSendToAgentPalette, openSendToAgentPaletteWithText } from "../useSendToAgentPalette";

function panel(id: string): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: "Claude",
    location: "grid",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    hasPty: true,
  };
}

/** Open the palette holding `text`, then pick the one target that isn't the source. */
function sendFromSourceToTarget(text: string): void {
  usePanelStore.setState({
    panelsById: { a: panel("a"), b: panel("b") },
    panelIds: ["a", "b"],
  });
  expect(openSendToAgentPaletteWithText(text, "a")).toBe(true);
  usePaletteStore.setState({ activePaletteId: "send-to-agent" });

  const { result } = renderHook(() => useSendToAgentPalette());
  const target = result.current.results.find((item) => item.id === "b");
  expect(target).toBeDefined();
  act(() => {
    result.current.selectItem(target!);
  });
}

describe("send to agent, target without bracketed paste", () => {
  beforeEach(() => {
    useWorktreeStoreOptionalMock.mockImplementation(
      (_selector: unknown, fallback: unknown) => fallback
    );
    writeMock.mockReset();
    notifyUserInputMock.mockReset();
    // The branch under test: a target whose program never turned bracketed
    // paste on, so the text goes in unwrapped.
    managed.value = { terminal: { modes: { bracketedPasteMode: false } } };
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  afterEach(() => {
    cleanup();
    usePaletteStore.setState({ activePaletteId: null });
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
  });

  it("neutralises control characters in the selected text", () => {
    // Terminal selection is whatever the source pane printed, escape sequences
    // included — none of it may reach the target's parser as bytes.
    sendFromSourceToTarget("ls\x1b[201~\x03rm -rf /\x15");

    expect(writeMock).toHaveBeenCalledWith("b", "ls␛[201~␃rm -rf /␕");
    expect(notifyUserInputMock).toHaveBeenCalledWith("b");
  });

  it("still submits each line, CRLF and bare CR alike", () => {
    sendFromSourceToTarget("one\r\ntwo\rthree\nfour");

    expect(writeMock).toHaveBeenCalledWith("b", "one\rtwo\rthree\rfour");
  });
});
